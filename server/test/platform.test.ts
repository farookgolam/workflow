import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { unscopedQuery } from '../src/db/query';
import { processArchive } from '../src/archive/worker';
import { purgeDueTenants } from '../src/platform/purge';
import { app, bearer, login, makePlatformAdmin, makeTenant, makeUser, recordStepAnswers, unique, platformLogin, PASSWORD } from './helpers';

let globalAdmin: { platformAdminId: number; email: string };
let token: string;

const asGlobal = (method: 'get' | 'post' | 'patch' | 'delete', path: string) => request(app)[method](`/api/v1/global${path}`).set(bearer(token));

beforeAll(async () => {
  globalAdmin = await makePlatformAdmin();
  token = (await platformLogin(globalAdmin.email)).body.accessToken;
});
afterAll(closePool);

describe('global administrator sign-in', () => {
  it('signs in and reports who it is, with a token the customer API will not accept', async () => {
    const res = await platformLogin(globalAdmin.email);
    expect(res.status).toBe(200);
    expect(res.body.admin).toMatchObject({ email: globalAdmin.email });

    const me = await request(app).get('/api/v1/global/auth/me').set(bearer(res.body.accessToken));
    expect(me.status).toBe(200);

    // a platform token is signed for a different audience: the customer API must reject it outright
    expect((await request(app).get('/api/v1/admin/users').set(bearer(res.body.accessToken))).status).toBe(401);
    expect((await request(app).get('/api/v1/my/requests').set(bearer(res.body.accessToken))).status).toBe(401);
  });

  it('refuses a wrong key, and an unknown address, the same way', async () => {
    expect((await platformLogin(globalAdmin.email, '999111')).status).toBe(401);
    expect((await platformLogin('nobody@example.test')).status).toBe(401);
  });

  it('a customer administrator cannot reach the global management API', async () => {
    const t = await makeTenant();
    await makeUser(t.tenantId, 'admin@example.test', ['Admin']);
    const customerToken = (await login(t.slug, 'admin@example.test')).body.accessToken;

    expect((await request(app).get('/api/v1/global/tenants').set(bearer(customerToken))).status).toBe(401);
    expect((await request(app).get('/api/v1/global/tenants')).status).toBe(401);
  });
});

describe('creating and managing customers', () => {
  it('creates a customer with its first administrator, who can then sign in', async () => {
    const slug = unique('acme');
    const created = await asGlobal('post', '/tenants').send({
      name: 'Acme Corp',
      slug,
      host: `${slug}.example.test`,
      adminEmail: 'owner@acme.test',
      adminDisplayName: 'Acme Owner',
    });

    expect(created.status).toBe(201);
    expect(created.body.tenant).toMatchObject({ slug, name: 'Acme Corp', isActive: true });
    expect(created.body.tenant.counts).toMatchObject({ users: 1, admins: 1 });
    const key: string = created.body.generatedAdminKey;
    expect(key).toMatch(/^\d{6}$/); // shown once, generated here because none was supplied

    const signedIn = await login(slug, 'owner@acme.test', key);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user).toMatchObject({ tenantId: created.body.tenant.tenantId, roles: ['Admin'] });

    // and that administrator manages their own organisation, not anybody else's
    const users = await request(app).get('/api/v1/admin/users').set(bearer(signedIn.body.accessToken));
    expect(users.body.users.map((u: { email: string }) => u.email)).toEqual(['owner@acme.test']);
  });

  it('refuses an address that is already taken', async () => {
    const slug = unique('dup');
    const body = { name: 'First', slug, adminEmail: 'a@dup.test', adminDisplayName: 'A Admin' };
    expect((await asGlobal('post', '/tenants').send(body)).status).toBe(201);

    const again = await asGlobal('post', '/tenants').send({ ...body, name: 'Second', adminEmail: 'b@dup.test', adminDisplayName: 'B Admin' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('slug_taken');
  });

  it('lists every customer with its usage, and shows one in detail', async () => {
    const slug = unique('listed');
    const created = await asGlobal('post', '/tenants').send({ name: 'Listed Ltd', slug, adminEmail: 'owner@listed.test', adminDisplayName: 'Listed Owner' });
    const tenantId = created.body.tenant.tenantId;

    const list = await asGlobal('get', '/tenants');
    expect(list.status).toBe(200);
    expect(list.body.tenants.map((t: { slug: string }) => t.slug)).toContain(slug);

    const detail = await asGlobal('get', `/tenants/${tenantId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.admins).toEqual([
      expect.objectContaining({ email: 'owner@listed.test', hasKey: true, isActive: true }),
    ]);
  });

  it('suspending a customer stops sign-in and ends open sessions; reactivating restores it', async () => {
    const slug = unique('susp');
    const created = await asGlobal('post', '/tenants').send({
      name: 'Suspendable',
      slug,
      adminEmail: 'owner@susp.test',
      adminDisplayName: 'Susp Owner',
      adminKey: PASSWORD,
    });
    const tenantId = created.body.tenant.tenantId;
    expect((await login(slug, 'owner@susp.test')).status).toBe(200);

    const suspended = await asGlobal('patch', `/tenants/${tenantId}`).send({ isActive: false });
    expect(suspended.status).toBe(200);
    expect(suspended.body.tenant.isActive).toBe(false);

    expect((await login(slug, 'owner@susp.test')).status).toBe(401);
    const open = await unscopedQuery<{ n: number }>(
      'SELECT COUNT(*) AS n FROM RefreshTokens WHERE TenantId = @T AND RevokedAt IS NULL',
      { T: tenantId },
    );
    expect(open[0].n).toBe(0);

    expect((await asGlobal('patch', `/tenants/${tenantId}`).send({ isActive: true })).status).toBe(200);
    expect((await login(slug, 'owner@susp.test')).status).toBe(200);
  });

  it('suspending a customer also kills tokens that are already in somebody hands', async () => {
    const slug = unique('live');
    const created = await asGlobal('post', '/tenants').send({
      name: 'Live Co',
      slug,
      adminEmail: 'owner@live.test',
      adminDisplayName: 'Live Owner',
      adminKey: PASSWORD,
    });
    const tenantId = created.body.tenant.tenantId;
    const token = (await login(slug, 'owner@live.test')).body.accessToken;
    expect((await request(app).get('/api/v1/admin/users').set(bearer(token))).status).toBe(200);

    await asGlobal('patch', `/tenants/${tenantId}`).send({ isActive: false });

    // the access token has not expired, but the user is re-read on every request and the customer is gone
    expect((await request(app).get('/api/v1/admin/users').set(bearer(token))).status).toBe(401);
    expect((await request(app).get('/api/v1/my/requests').set(bearer(token))).status).toBe(401);
  });

  it('grants and revokes the Admin role inside a customer', async () => {
    const t = await makeTenant();
    await makeUser(t.tenantId, 'person@example.test', ['Submitter']);

    expect((await asGlobal('post', `/tenants/${t.tenantId}/admins`).send({ email: 'person@example.test' })).status).toBe(200);
    const asAdmin = await login(t.slug, 'person@example.test');
    expect(asAdmin.body.user.roles).toContain('Admin');

    expect((await asGlobal('post', `/tenants/${t.tenantId}/admins`).send({ email: 'person@example.test', remove: true })).status).toBe(200);
    expect((await login(t.slug, 'person@example.test')).body.user.roles).not.toContain('Admin');

    // somebody who is not in that organisation at all
    expect((await asGlobal('post', `/tenants/${t.tenantId}/admins`).send({ email: 'stranger@example.test' })).status).toBe(404);
  });

  it('resets a customer administrator key without ever learning it', async () => {
    const t = await makeTenant();
    const userId = await makeUser(t.tenantId, 'locked@example.test', ['Admin']);
    expect((await login(t.slug, 'locked@example.test')).status).toBe(200);

    const reset = await asGlobal('post', `/tenants/${t.tenantId}/admins/${userId}/reset-key`);
    expect(reset.status).toBe(200);
    expect(JSON.stringify(reset.body)).not.toContain(PASSWORD);

    // the old key no longer works; the person sets a new one through first-time setup
    expect((await login(t.slug, 'locked@example.test')).status).toBe(401);
  });
});

describe('removing a customer permanently', () => {
  /** A customer with a person, a form, a chain and one closed (rejected) request: every kind of protected history. */
  async function busyCustomer() {
    const slug = unique('gone');
    const created = await asGlobal('post', '/tenants').send({ name: 'Gone Ltd', slug, adminEmail: 'owner@gone.test', adminDisplayName: 'Gone Owner', adminKey: PASSWORD });
    const tenantId: number = created.body.tenant.tenantId;
    const admin = (await login(slug, 'owner@gone.test')).body.accessToken;
    const approverId = await makeUser(tenantId, 'ann@gone.test', ['Approver']);
    await makeUser(tenantId, 'sam@gone.test', ['Submitter']);
    const sam = (await login(slug, 'sam@gone.test')).body.accessToken;
    const ann = (await login(slug, 'ann@gone.test')).body.accessToken;

    const form = await request(app).post('/api/v1/admin/forms').set(bearer(admin)).send({
      name: 'Expense', slug: 'expense', fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
    });
    await request(app).put(`/api/v1/admin/forms/${form.body.formId}/chain`).set(bearer(admin)).send({
      steps: [{ name: 'Manager', approverUserId: approverId }],
    });
    const submitted = await request(app).post(`/api/v1/forms/${form.body.formId}/requests`).set(bearer(sam)).send({ values: { title: 'Taxi' } });
    expect(submitted.status).toBe(201);
    const [step] = await unscopedQuery<{ RequestStepId: number }>('SELECT RequestStepId FROM RequestSteps WHERE TenantId = @T', { T: tenantId });
    const decided = await request(app).post(`/api/v1/approvals/${step.RequestStepId}/decision`).set(bearer(ann))
      .send({ decision: 'reject', rejectionReason: 'No receipt' });
    expect(decided.status).toBe(200);
    await recordStepAnswers(tenantId, step.RequestStepId, [{ key: 'note', label: 'Note', type: 'text', value: 'x' }]); // an older chain's answer, locked like the rest
    // its PDF is archived in the database, which is locked like the audit log - removal must still clear it
    expect((await processArchive({ tenantId })).generated).toBe(1);
    return { tenantId, slug };
  }

  const rowsLeft = async (tenantId: number) => {
    const tables = await unscopedQuery<{ name: string }>(
      `SELECT t.name FROM sys.tables t JOIN sys.columns c ON c.object_id = t.object_id
        WHERE c.name = 'TenantId' AND t.name <> 'PlatformAuditLog'`,
    );
    const left: Record<string, number> = {};
    for (const { name } of tables) {
      const [{ n }] = await unscopedQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM [${name}] WHERE TenantId = @T`, { T: tenantId });
      if (n) left[name] = n;
    }
    return left;
  };

  it('refuses while the customer is active, and without the right slug', async () => {
    const { tenantId, slug } = await busyCustomer();

    const active = await asGlobal('delete', `/tenants/${tenantId}`).send({ confirmSlug: slug });
    expect(active.status).toBe(409);
    expect(active.body.error.code).toBe('not_suspended');

    await asGlobal('patch', `/tenants/${tenantId}`).send({ isActive: false });
    const wrong = await asGlobal('delete', `/tenants/${tenantId}`).send({ confirmSlug: 'something-else' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('confirm_mismatch');

    expect(Object.keys(await rowsLeft(tenantId))).toContain('AuditLog'); // nothing was touched
  });

  it('removing keeps everything for the grace period, frozen but restorable', async () => {
    const { tenantId, slug } = await busyCustomer();
    await asGlobal('patch', `/tenants/${tenantId}`).send({ isActive: false });
    const before = await rowsLeft(tenantId);

    const removed = await asGlobal('delete', `/tenants/${tenantId}`).send({ confirmSlug: slug });
    expect(removed.status).toBe(200);
    expect(removed.body.tenant.removedAt).toBeTruthy();
    const days = (new Date(removed.body.tenant.purgeAfter).getTime() - new Date(removed.body.tenant.removedAt).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(30);

    // nothing is gone, nobody can sign in, and nothing can be changed or reactivated
    const { AuditLog: auditBefore, ...kept } = before; // removal adds its own audit row
    expect(await rowsLeft(tenantId)).toMatchObject({ ...kept, AuditLog: auditBefore + 1 });
    expect((await login(slug, 'owner@gone.test')).status).toBe(401);
    expect((await asGlobal('patch', `/tenants/${tenantId}`).send({ isActive: true })).body.error.code).toBe('removed');
    expect((await asGlobal('patch', `/tenants/${tenantId}/settings`).send({})).status).toBe(409);
    expect((await asGlobal('delete', `/tenants/${tenantId}`).send({ confirmSlug: slug })).status).toBe(409);

    // a purge run before the date leaves it alone
    expect(await purgeDueTenants()).not.toContain(tenantId);

    // restoring brings it back suspended; reactivating is then the usual step
    const restored = await asGlobal('post', `/tenants/${tenantId}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.tenant).toMatchObject({ removedAt: null, purgeAfter: null, isActive: false });
    expect((await asGlobal('patch', `/tenants/${tenantId}`).send({ isActive: true })).status).toBe(200);
    expect((await login(slug, 'owner@gone.test')).status).toBe(200);

    const actions = await unscopedQuery<{ Action: string }>(
      `SELECT Action FROM PlatformAuditLog WHERE TenantId = @T AND Action IN ('tenant.removed','tenant.restored') ORDER BY PlatformAuditId`,
      { T: tenantId },
    );
    expect(actions.map((a) => a.Action)).toEqual(['tenant.removed', 'tenant.restored']);
  });

  it('once the grace period is over, the purge job deletes every row, closed requests and audit history included', async () => {
    const { tenantId, slug } = await busyCustomer();
    await asGlobal('patch', `/tenants/${tenantId}`).send({ isActive: false });
    expect((await asGlobal('delete', `/tenants/${tenantId}`).send({ confirmSlug: slug })).status).toBe(200);

    // time passes
    await unscopedQuery('UPDATE Tenants SET PurgeAfter = DATEADD(MINUTE, -1, SYSUTCDATETIME()) WHERE TenantId = @T', { T: tenantId });
    expect(await purgeDueTenants()).toContain(tenantId);

    expect(await rowsLeft(tenantId)).toEqual({});
    expect((await asGlobal('get', `/tenants/${tenantId}`)).status).toBe(404);

    const [record] = await unscopedQuery<{ PlatformAdminId: number | null; DetailJson: string }>(
      `SELECT PlatformAdminId, DetailJson FROM PlatformAuditLog WHERE TenantId = @T AND Action = 'tenant.deleted'`,
      { T: tenantId },
    );
    expect(record.PlatformAdminId).toBeNull(); // done by the system, on the date the removal set
    expect(JSON.parse(record.DetailJson)).toMatchObject({ name: 'Gone Ltd', slug });

    const stats = await asGlobal('get', '/stats');
    const entries = stats.body.recentActivity.filter((a: { tenantId: number }) => a.tenantId === tenantId);
    expect(entries.map((a: { tenantName: string }) => a.tenantName)).toEqual(expect.arrayContaining(['Gone Ltd']));
  });

  it('does not loosen the history guards for anyone else', async () => {
    const { tenantId } = await busyCustomer();
    await asGlobal('patch', `/tenants/${tenantId}`).send({ isActive: false });

    // outside the procedure, closed history stays locked even for a suspended customer
    await expect(unscopedQuery('DELETE FROM AuditLog WHERE TenantId = @T', { T: tenantId })).rejects.toThrow(/append-only/);
    await expect(unscopedQuery('DELETE FROM StepResponses WHERE TenantId = @T', { T: tenantId })).rejects.toThrow(/immutable/);

    // and a purge mark naming one customer does not unlock another's rows
    const other = await busyCustomer();
    await asGlobal('patch', `/tenants/${other.tenantId}`).send({ isActive: false });
    await expect(unscopedQuery(
      `EXEC sp_set_session_context N'af.purge_tenant', @T; DELETE FROM AuditLog WHERE TenantId = @Other;`,
      { T: tenantId, Other: other.tenantId },
    )).rejects.toThrow(/append-only/);

    // the procedure itself refuses an active customer
    const active = await busyCustomer();
    await expect(unscopedQuery('EXEC dbo.PurgeTenant @TenantId = @T', { T: active.tenantId })).rejects.toThrow(/Suspend/);
  });
});

describe('what the global administrator leaves behind', () => {
  it('records its actions in the platform log, which is append-only', async () => {
    const slug = unique('audited');
    const created = await asGlobal('post', '/tenants').send({ name: 'Audited', slug, adminEmail: 'owner@audited.test', adminDisplayName: 'Audited Owner' });
    const tenantId = created.body.tenant.tenantId;

    const [row] = await unscopedQuery<{ Action: string; PlatformAdminId: number; IpAddress: string | null }>(
      `SELECT TOP 1 Action, PlatformAdminId, IpAddress FROM PlatformAuditLog
        WHERE TenantId = @T AND Action = 'tenant.created' ORDER BY PlatformAuditId DESC`,
      { T: tenantId },
    );
    expect(row).toMatchObject({ Action: 'tenant.created', PlatformAdminId: globalAdmin.platformAdminId });

    await expect(unscopedQuery('DELETE FROM PlatformAuditLog WHERE TenantId = @T', { T: tenantId })).rejects.toThrow(/append-only/);
    await expect(unscopedQuery(`UPDATE PlatformAuditLog SET Action = 'x' WHERE TenantId = @T`, { T: tenantId })).rejects.toThrow(/append-only/);
  });

  it('is visible from inside the customer too: suspending shows up in that customer own audit log', async () => {
    const slug = unique('seen');
    const created = await asGlobal('post', '/tenants').send({ name: 'Seen', slug, adminEmail: 'owner@seen.test', adminDisplayName: 'Seen Owner' });
    const tenantId = created.body.tenant.tenantId;
    await asGlobal('patch', `/tenants/${tenantId}`).send({ isActive: false });

    const rows = await unscopedQuery<{ Action: string; DetailJson: string }>(
      `SELECT Action, DetailJson FROM AuditLog WHERE TenantId = @T AND Action IN ('tenant.created','tenant.suspended') ORDER BY AuditId`,
      { T: tenantId },
    );
    expect(rows.map((r) => r.Action)).toEqual(['tenant.created', 'tenant.suspended']);
    expect(rows[1].DetailJson).toContain(globalAdmin.email);
  });

  it('global administrators are not users: no customer can see or manage one', async () => {
    const t = await makeTenant();
    await makeUser(t.tenantId, 'admin@example.test', ['Admin']);
    const customerToken = (await login(t.slug, 'admin@example.test')).body.accessToken;

    const users = await request(app).get('/api/v1/admin/users').set(bearer(customerToken));
    expect(users.body.users.map((u: { email: string }) => u.email)).not.toContain(globalAdmin.email);

    const anywhere = await unscopedQuery<{ n: number }>('SELECT COUNT(*) AS n FROM Users WHERE Email = @E', { E: globalAdmin.email });
    expect(anywhere[0].n).toBe(0);
  });
});
