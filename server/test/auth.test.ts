import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { PASSWORD, app, bearer, login, makeTenant, makeUser, refreshCookie } from './helpers';

let tenant: { tenantId: number; slug: string };

beforeAll(async () => {
  tenant = await makeTenant();
  await makeUser(tenant.tenantId, 'admin@example.test', ['Admin']);
});
afterAll(closePool);

describe('login', () => {
  it('returns an access token, the profile and an httpOnly refresh cookie', async () => {
    const res = await login(tenant.slug, 'Admin@Example.test');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'admin@example.test', roles: ['Admin'], tenantId: tenant.tenantId });
    expect(res.body.user.PasswordHash).toBeUndefined();
    const cookie = ([] as string[]).concat(res.headers['set-cookie']).join(';');
    expect(cookie).toMatch(/af_rt=.*HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);

    const me = await request(app).get('/api/v1/auth/me').set(bearer(res.body.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('admin@example.test');
  });

  it('gives the same 401 for wrong password, unknown email and unknown tenant', async () => {
    const results = await Promise.all([
      login(tenant.slug, 'admin@example.test', 'wrong-password-1'),
      login(tenant.slug, 'nobody@example.test'),
      login('no-such-tenant', 'admin@example.test'),
    ]);
    for (const r of results) {
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('invalid_credentials');
    }
  });

  it('validates input', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ tenantSlug: tenant.slug, email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('locks the account after 5 failures, even for the correct password, and audits it', async () => {
    const userId = await makeUser(tenant.tenantId, 'lockme@example.test', ['Submitter']);
    for (let i = 0; i < 5; i++) expect((await login(tenant.slug, 'lockme@example.test', 'bad-password-x')).status).toBe(401);
    expect((await login(tenant.slug, 'lockme@example.test')).status).toBe(401);

    const actions = (
      await tenantQuery<{ Action: string }>(
        tenant.tenantId,
        'SELECT Action FROM AuditLog WHERE TenantId = @TenantId AND EntityId = @UserId ORDER BY AuditId',
        { UserId: userId },
      )
    ).map((r) => r.Action);
    expect(actions.filter((a) => a === 'auth.login_failed')).toHaveLength(4);
    expect(actions).toContain('auth.account_locked');
    expect(actions.at(-1)).toBe('auth.login_blocked_locked');
  });

  it('rejects requests without a valid bearer token', async () => {
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set(bearer('garbage'))).status).toBe(401);
  });

  it('stops honouring a token as soon as the user is deactivated', async () => {
    const userId = await makeUser(tenant.tenantId, 'leaver@example.test', ['Approver']);
    const { body } = await login(tenant.slug, 'leaver@example.test');
    await tenantQuery(tenant.tenantId, 'UPDATE Users SET IsActive = 0 WHERE TenantId = @TenantId AND UserId = @UserId', { UserId: userId });
    expect((await request(app).get('/api/v1/auth/me').set(bearer(body.accessToken))).status).toBe(401);
  });
});

describe('refresh tokens', () => {
  it('rotates on use, and replaying an old token revokes the whole session family', async () => {
    const first = refreshCookie(await login(tenant.slug, 'admin@example.test'));

    const rotated = await request(app).post('/api/v1/auth/refresh').set('Cookie', first);
    expect(rotated.status).toBe(200);
    expect(rotated.body.accessToken).toBeTruthy();
    const second = refreshCookie(rotated);
    expect(second).not.toBe(first);

    // an immediate duplicate is treated as two tabs racing: refused, but nobody is signed out
    const race = await request(app).post('/api/v1/auth/refresh').set('Cookie', first);
    expect(race.status).toBe(401);
    expect(race.body.error.code).toBe('refresh_race');

    // the same old token turning up later is theft
    await tenantQuery(tenant.tenantId, 'UPDATE RefreshTokens SET RevokedAt = DATEADD(MINUTE, -1, RevokedAt) WHERE TenantId = @TenantId AND RevokedAt IS NOT NULL');
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', first)).status).toBe(401); // replay
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', second)).status).toBe(401); // family revoked
  });

  it('logout revokes the refresh token', async () => {
    const cookie = refreshCookie(await login(tenant.slug, 'admin@example.test'));
    expect((await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)).status).toBe(204);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(401);
  });
});

describe('password key', () => {
  it('change requires the current key and a valid 6-digit new one', async () => {
    await makeUser(tenant.tenantId, 'changer@example.test', ['Submitter']);
    const { body } = await login(tenant.slug, 'changer@example.test');
    const change = (currentPassword: string, newPassword: string) =>
      request(app).post('/api/v1/auth/change-password').set(bearer(body.accessToken)).send({ currentPassword, newPassword });

    expect((await change('000001', '907351')).body.error.code).toBe('wrong_password');
    for (const weak of ['12345', '1234567', 'abcdef', '111111', '123456', '654321', '121212', '123123']) {
      const res = await change(PASSWORD, weak);
      expect([weak, res.status]).toEqual([weak, 400]);
    }
    expect((await change(PASSWORD, '907351')).status).toBe(204);
    expect((await login(tenant.slug, 'changer@example.test', PASSWORD)).status).toBe(401);
    expect((await login(tenant.slug, 'changer@example.test', '907351')).status).toBe(200);
  });

  it('the old link-based reset endpoints are gone (self-service now uses an emailed code)', async () => {
    expect((await request(app).post('/api/v1/auth/forgot-password').send({ email: 'changer@example.test' })).status).toBe(404);
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token: 'x'.repeat(30), newPassword: '907351' })).status).toBe(404);
  });
});
