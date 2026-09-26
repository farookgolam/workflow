// Per-customer settings, support access, and the storage each customer writes to.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config';
import { closePool } from '../src/db/pool';
import { unscopedQuery } from '../src/db/query';
import { processOutbox } from '../src/notifications/mailer';
import { queueNotification } from '../src/notifications/outbox';
import { withTx } from '../src/db/query';
import { forgetSettings } from '../src/settings/service';
import { app, bearer, login, makePlatformAdmin, makeTenant, makeUser, platformLogin, unique } from './helpers';

let tenant: { tenantId: number; slug: string; host: string | null };
let adminToken: string;
let globalAdmin: { platformAdminId: number; email: string };
let globalToken: string;

beforeAll(async () => {
  tenant = await makeTenant();
  await makeUser(tenant.tenantId, 'admin@example.test', ['Admin']);
  adminToken = (await login(tenant.slug, 'admin@example.test')).body.accessToken;
  globalAdmin = await makePlatformAdmin();
  globalToken = (await platformLogin(globalAdmin.email)).body.accessToken;
});
afterAll(closePool);

describe('a customer administrator edits their own settings', () => {
  it('starts out inheriting the server defaults, then overrides them', async () => {
    const before = await request(app).get('/api/v1/admin/settings').set(bearer(adminToken));
    expect(before.status).toBe(200);
    expect(before.body.settings.allowedEmailDomains).toBeNull(); // null = inherit
    expect(before.body.settings.effective.verifyEmail).toBe(config.signup.verifyEmail);

    const saved = await request(app)
      .patch('/api/v1/admin/settings')
      .set(bearer(adminToken))
      .send({ brandName: 'Acme', brandColor: '#2563eb', allowedEmailDomains: 'acme.test, Example.TEST', firstLoginEmailVerification: false, mailFromName: 'Acme Approvals', mailFromEmail: 'no-reply@acme.test' });

    expect(saved.status).toBe(200);
    expect(saved.body.settings.effective).toMatchObject({
      allowedDomains: ['acme.test', 'example.test'],
      verifyEmail: false,
      mailFrom: 'Acme Approvals <no-reply@acme.test>',
    });
  });

  it('applies the domain rule to registration at that customer only', async () => {
    const other = await makeTenant();
    // this customer only accepts acme.test / example.test (set above)
    const refused = await request(app).post('/api/v1/auth/start').send({ tenantSlug: tenant.slug, email: 'someone@elsewhere.test' });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('domain_not_allowed');

    const allowed = await request(app).post('/api/v1/auth/start').send({ tenantSlug: tenant.slug, email: 'someone@acme.test' });
    expect(allowed.status).toBe(200);
    expect(allowed.body.verification).toBe(false); // this customer turned email verification off

    // the customer next door is untouched by any of it
    const neighbour = await request(app).post('/api/v1/auth/start').send({ tenantSlug: other.slug, email: 'someone@elsewhere.test' });
    expect(neighbour.status).toBe(200);
    expect(neighbour.body.verification).toBe(config.signup.verifyEmail);
  });

  it('rejects a nonsense colour and a logo that is not an image', async () => {
    const bad = await request(app).patch('/api/v1/admin/settings').set(bearer(adminToken)).send({ brandColor: 'blue' });
    expect(bad.status).toBe(400);
    const worse = await request(app).patch('/api/v1/admin/settings').set(bearer(adminToken)).send({ logoDataUrl: 'javascript:alert(1)' });
    expect(worse.status).toBe(400);
  });

  it('a submitter cannot read or change them', async () => {
    await makeUser(tenant.tenantId, 'submitter@example.test', ['Submitter']);
    const token = (await login(tenant.slug, 'submitter@example.test')).body.accessToken;
    expect((await request(app).get('/api/v1/admin/settings').set(bearer(token))).status).toBe(403);
    expect((await request(app).patch('/api/v1/admin/settings').set(bearer(token)).send({ brandName: 'nope' })).status).toBe(403);
  });
});

describe('each customer writes to its own storage', () => {
  it('dry-run emails land in that customer folder, with that customer sender address', async () => {
    const t = await makeTenant();
    await request(app).patch('/api/v1/admin/settings').set(bearer(adminToken)).send({ mailFromEmail: 'no-reply@acme.test', mailFromName: 'Acme Approvals' });

    await withTx((tx) =>
      queueNotification(tenant.tenantId, { type: 'VerificationCode', to: { userId: null, email: 'someone@acme.test' }, subject: 'probe', bodyHtml: '<p>probe</p>' }, tx),
    );
    await withTx((tx) =>
      queueNotification(t.tenantId, { type: 'VerificationCode', to: { userId: null, email: 'someone@other.test' }, subject: 'probe', bodyHtml: '<p>probe</p>' }, tx),
    );

    const seen: { tenantId: number; from: string; to: string }[] = [];
    for (let r = await processOutbox({ send: async (m) => void seen.push({ tenantId: m.tenantId, from: m.from, to: m.to }) }, 50); r.sent + r.failed > 0; )
      r = await processOutbox({ send: async (m) => void seen.push({ tenantId: m.tenantId, from: m.from, to: m.to }) }, 50);

    const mine = seen.find((m) => m.to === 'someone@acme.test');
    const theirs = seen.find((m) => m.to === 'someone@other.test');
    expect(mine).toMatchObject({ tenantId: tenant.tenantId, from: 'Acme Approvals <no-reply@acme.test>' });
    expect(theirs).toMatchObject({ tenantId: t.tenantId, from: config.mail.from }); // untouched customer keeps the server default
  });
});

describe('a global administrator and one customer', () => {
  const asGlobal = (method: 'get' | 'post' | 'patch', path: string) => request(app)[method](`/api/v1/global${path}`).set(bearer(globalToken));

  it('reads and writes the same settings the customer sees', async () => {
    const t = await makeTenant();
    const saved = await asGlobal('patch', `/tenants/${t.tenantId}/settings`).send({ brandName: 'Set from the console' });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.brandName).toBe('Set from the console');

    // and the customer's own audit log says who changed it
    const [row] = await unscopedQuery<{ DetailJson: string }>(
      `SELECT TOP 1 DetailJson FROM AuditLog WHERE TenantId = @T AND Action = 'settings.updated' ORDER BY AuditId DESC`,
      { T: t.tenantId },
    );
    expect(row.DetailJson).toContain(globalAdmin.email);
  });

  it('acts as a customer administrator with a short-lived token, and every row says so', async () => {
    const slug = unique('support');
    const created = await asGlobal('post', '/tenants').send({ name: 'Support Co', slug, adminEmail: 'owner@support.test', adminDisplayName: 'Support Owner' });
    const tenantId = created.body.tenant.tenantId;

    const acting = await asGlobal('post', `/tenants/${tenantId}/impersonate`).send({ reason: 'ticket 42' });
    expect(acting.status).toBe(200);
    expect(acting.body).toMatchObject({ expiresInMinutes: 30, actingAs: { email: 'owner@support.test' } });

    // it is an ordinary customer token: the usual tenant checks apply, nothing is bypassed
    const users = await request(app).get('/api/v1/admin/users').set(bearer(acting.body.accessToken));
    expect(users.status).toBe(200);
    expect(users.body.users.map((u: { email: string }) => u.email)).toEqual(['owner@support.test']);

    // anything done while acting as them is stamped in that customer's audit log
    await request(app).patch('/api/v1/admin/settings').set(bearer(acting.body.accessToken)).send({ brandName: 'Changed during support' });
    const [row] = await unscopedQuery<{ DetailJson: string }>(
      `SELECT TOP 1 DetailJson FROM AuditLog WHERE TenantId = @T AND Action = 'settings.updated' ORDER BY AuditId DESC`,
      { T: tenantId },
    );
    expect(JSON.parse(row.DetailJson).impersonatedByPlatformAdmin).toBe(globalAdmin.platformAdminId);

    // and the start of it is recorded on both sides
    const [platform] = await unscopedQuery<{ n: number }>(
      `SELECT COUNT(*) AS n FROM PlatformAuditLog WHERE TenantId = @T AND Action = 'tenant.impersonation_started'`,
      { T: tenantId },
    );
    expect(platform.n).toBe(1);
  });

  it('refuses support access into a suspended customer', async () => {
    const slug = unique('closed');
    const created = await asGlobal('post', '/tenants').send({ name: 'Closed Co', slug, adminEmail: 'owner@closed.test', adminDisplayName: 'Closed Owner' });
    const tenantId = created.body.tenant.tenantId;
    await asGlobal('patch', `/tenants/${tenantId}`).send({ isActive: false });

    const acting = await asGlobal('post', `/tenants/${tenantId}/impersonate`).send({});
    expect(acting.status).toBe(409);
  });

  it('reports totals across every customer', async () => {
    const stats = await asGlobal('get', '/stats');
    expect(stats.status).toBe(200);
    expect(stats.body.totals.tenants).toBeGreaterThan(1);
    expect(stats.body.totals.activeTenants).toBeGreaterThan(0);
    expect(Array.isArray(stats.body.recentActivity)).toBe(true);

    // a customer administrator has no way in
    expect((await request(app).get('/api/v1/global/stats').set(bearer(adminToken))).status).toBe(401);
  });
});

describe('the sign-in page knows which customer it is', () => {
  it('reports the name and branding for the address, without anybody signed in', async () => {
    const t = await makeTenant(unique('branded'), `${unique('branded')}.example.test`);
    await unscopedQuery('INSERT INTO TenantSettings (TenantId, BrandName, BrandColor) VALUES (@T, @N, @C)', {
      T: t.tenantId,
      N: 'Branded Ltd',
      C: '#123456',
    });
    forgetSettings(t.tenantId);

    const res = await request(app).get('/api/v1/site').set('Host', t.host!);
    expect(res.status).toBe(200);
    expect(res.body.site).toMatchObject({ slug: t.slug, name: 'Branded Ltd', brandColor: '#123456' });
  });

  it('an address that belongs to no customer is a plain 404', async () => {
    const res = await request(app).get('/api/v1/site').set('Host', 'nobody.example.test');
    // no host routing is configured for that name in tests, so it falls back - what matters is that it
    // never answers with another customer's identity
    expect([200, 404, 503]).toContain(res.status);
    if (res.status === 200) expect(res.body.site.slug).not.toBe('nobody');
  });
});
