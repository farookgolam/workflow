import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { unusablePasswordHash } from '../src/auth/password';
import { withTx } from '../src/db/query';
import { createUser } from '../src/users/service';
import { PASSWORD, app, bearer, login, makeTenant, makeUser, refreshCookie } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let adminToken: string;

const start = (email: string) => request(app).post(`${api}/auth/start`).send({ email, tenantSlug: t.slug });
const setup = (body: Record<string, unknown>) => request(app).post(`${api}/auth/setup`).send({ tenantSlug: t.slug, ...body });
async function emailedCode(email: string): Promise<string> {
  const [m] = await tenantQuery<{ BodyHtml: string; Subject: string }>(
    t.tenantId, `SELECT TOP 1 BodyHtml, Subject FROM Notifications WHERE TenantId = @TenantId AND Type = 'VerificationCode' AND RecipientEmail = @E ORDER BY NotificationId DESC`, { E: email });
  return /(\d{6})/.exec(m.Subject)![1];
}
/** Lets a second code be requested immediately (the API refuses to resend within a minute). */
const expireResendWindow = (email: string) =>
  tenantQuery(t.tenantId, 'UPDATE EmailVerifications SET CreatedAt = DATEADD(MINUTE, -2, CreatedAt) WHERE TenantId = @TenantId AND Email = @E', { E: email });

beforeAll(async () => {
  t = await makeTenant();
  await makeUser(t.tenantId, 'admin@su.test', ['Admin'], 'ADMIN');
  adminToken = (await login(t.slug, 'admin@su.test')).body.accessToken;
});
afterAll(closePool);

describe('first sign-in: create your own 6-digit password key', () => {
  it('a new person registers with a verified email, becomes a Submitter, and is signed in', async () => {
    const s = await start('New.Person@su.test');
    expect(s.body).toEqual({ next: 'setup', verification: true, needsName: true, displayName: null });
    const code = await emailedCode('new.person@su.test');

    // needs a name, a valid key and the right code
    expect((await setup({ email: 'new.person@su.test', code, passwordKey: '907351' })).body.error.details[0].path).toBe('displayName');
    expect((await setup({ email: 'new.person@su.test', code, displayName: 'New Person', passwordKey: '123456' })).body.error.details[0].path).toBe('passwordKey');
    expect((await setup({ email: 'new.person@su.test', displayName: 'New Person', passwordKey: '907351' })).body.error.details[0].path).toBe('code');

    const done = await setup({ email: 'new.person@su.test', code, displayName: 'New Person', passwordKey: '907351' });
    expect(done.status).toBe(201);
    expect(done.body.user).toMatchObject({ email: 'new.person@su.test', displayName: 'New Person', roles: ['Submitter'] });
    expect(refreshCookie(done)).toMatch(/^af_rt=/);
    expect((await request(app).get(`${api}/auth/me`).set(bearer(done.body.accessToken))).status).toBe(200);

    // from now on it is an ordinary sign-in; setup can never overwrite an existing key
    expect((await start('new.person@su.test')).body).toEqual({ next: 'password' });
    expect((await login(t.slug, 'new.person@su.test', '907351')).status).toBe(200);
    expect((await setup({ email: 'new.person@su.test', code, displayName: 'Evil', passwordKey: '864209' })).status).toBe(409);

    // the administrator did nothing, but can see the new account
    const users = (await request(app).get(`${api}/admin/users`).set(bearer(adminToken))).body.users;
    expect(users.find((u: { email: string }) => u.email === 'new.person@su.test')).toMatchObject({ hasKey: true, roles: ['Submitter'], isActive: true });
  });

  it('knowing someone\'s email address is not enough: the code goes to THEIR mailbox and guesses are limited', async () => {
    await start('victim@su.test');
    const real = await emailedCode('victim@su.test');
    const wrong = real === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i++) {
      const res = await setup({ email: 'victim@su.test', code: wrong, displayName: 'Attacker', passwordKey: '907351' });
      expect(res.status).toBe(400);
    }
    // after 5 misses even the right code is dead; a new one must be requested
    expect((await setup({ email: 'victim@su.test', code: real, displayName: 'Victim', passwordKey: '907351' })).body.error.details[0].message).toMatch(/expired/);
    expect((await login(t.slug, 'victim@su.test', '907351')).status).toBe(401);

    // asking again within a minute does not send another email (no mailbox flooding)
    const before = (await tenantQuery<{ n: number }>(t.tenantId, `SELECT COUNT(*) AS n FROM Notifications WHERE TenantId = @TenantId AND RecipientEmail = 'victim@su.test'`))[0].n;
    await start('victim@su.test');
    const after = (await tenantQuery<{ n: number }>(t.tenantId, `SELECT COUNT(*) AS n FROM Notifications WHERE TenantId = @TenantId AND RecipientEmail = 'victim@su.test'`))[0].n;
    expect(after).toBe(before);

    await expireResendWindow('victim@su.test');
    await start('victim@su.test');
    const fresh = await emailedCode('victim@su.test');
    expect((await setup({ email: 'victim@su.test', code: fresh, displayName: 'Victim', passwordKey: '907351' })).status).toBe(201);
    // a code works once
    expect((await setup({ email: 'victim@su.test', code: fresh, displayName: 'Victim', passwordKey: '907351' })).status).toBe(409);
  });

  it('stores only a keyed hash of the code, never the code itself', async () => {
    await start('hash@su.test');
    const code = await emailedCode('hash@su.test');
    const [v] = await tenantQuery<{ CodeHash: Buffer }>(t.tenantId, `SELECT TOP 1 CodeHash FROM EmailVerifications WHERE TenantId = @TenantId AND Email = 'hash@su.test' ORDER BY VerificationId DESC`);
    expect(v.CodeHash).toHaveLength(32);
    expect(v.CodeHash.toString('hex')).not.toContain(Buffer.from(code).toString('hex'));
  });
});

describe('forgotten key: self-service', () => {
  const forgot = (email: string) => request(app).post(`${api}/auth/forgot`).send({ email, tenantSlug: t.slug });
  const resetKey = (body: Record<string, unknown>) => request(app).post(`${api}/auth/reset-key`).send({ tenantSlug: t.slug, ...body });

  it('an emailed code lets the owner choose a new key; old sessions and the old key stop working', async () => {
    const userId = await makeUser(t.tenantId, 'oops@su.test', ['Approver'], 'Oops');
    const oldSession = refreshCookie(await login(t.slug, 'oops@su.test'));

    // same answer for unknown addresses, and nothing is sent to them
    const known = await forgot('oops@su.test');
    const unknown = await forgot('nobody-here@su.test');
    expect(known.status).toBe(202);
    expect(unknown.body).toEqual(known.body);
    const [ghost] = await tenantQuery<{ n: number }>(t.tenantId, `SELECT COUNT(*) AS n FROM Notifications WHERE TenantId = @TenantId AND RecipientEmail = 'nobody-here@su.test'`);
    expect(ghost.n).toBe(0);

    const code = await emailedCode('oops@su.test');
    expect((await resetKey({ email: 'oops@su.test', code, passwordKey: '111111' })).body.error.details[0].path).toBe('passwordKey');
    expect((await resetKey({ email: 'oops@su.test', code: code === '000000' ? '000001' : '000000', passwordKey: '730915' })).body.error.details[0].path).toBe('code');

    const done = await resetKey({ email: 'oops@su.test', code, passwordKey: '730915' });
    expect(done.status).toBe(200);
    expect(done.body.user).toMatchObject({ userId, roles: ['Approver'] }); // signed in, roles untouched

    expect((await login(t.slug, 'oops@su.test', PASSWORD)).status).toBe(401);
    expect((await login(t.slug, 'oops@su.test', '730915')).status).toBe(200);
    expect((await request(app).post(`${api}/auth/refresh`).set('Cookie', oldSession)).status).toBe(401);
    expect((await resetKey({ email: 'oops@su.test', code, passwordKey: '864209' })).status).toBe(400); // a code works once

    const actions = (await tenantQuery<{ Action: string }>(t.tenantId, `SELECT Action FROM AuditLog WHERE TenantId = @TenantId AND EntityType = 'User' AND EntityId = @U`, { U: userId })).map((a) => a.Action);
    expect(actions).toEqual(expect.arrayContaining(['auth.key_reset_requested', 'auth.key_reset_self']));
  });

  it('also unlocks a locked account, but never works for a deactivated one or without the code', async () => {
    const userId = await makeUser(t.tenantId, 'lockedout@su.test', ['Submitter'], 'Locked');
    for (let i = 0; i < 5; i++) await login(t.slug, 'lockedout@su.test', '000001');
    expect((await login(t.slug, 'lockedout@su.test')).status).toBe(401); // locked, even with the right key

    expect((await resetKey({ email: 'lockedout@su.test', code: '123456', passwordKey: '730915' })).status).toBe(400); // no code requested yet
    await forgot('lockedout@su.test');
    expect((await resetKey({ email: 'lockedout@su.test', code: await emailedCode('lockedout@su.test'), passwordKey: '730915' })).status).toBe(200);
    expect((await login(t.slug, 'lockedout@su.test', '730915')).status).toBe(200);

    await tenantQuery(t.tenantId, 'UPDATE Users SET IsActive = 0 WHERE TenantId = @TenantId AND UserId = @U', { U: userId });
    await expireResendWindow('lockedout@su.test');
    await forgot('lockedout@su.test');
    const [sent] = await tenantQuery<{ n: number }>(t.tenantId, `SELECT COUNT(*) AS n FROM Notifications WHERE TenantId = @TenantId AND RecipientEmail = 'lockedout@su.test'`);
    expect(sent.n).toBe(1); // only the earlier one - nothing is sent for a deactivated account
  });
});

describe('forgotten key: administrator reset (fallback)', () => {
  it('reset signs the user out, blocks the old key, and sends them back through verified setup keeping their roles', async () => {
    const userId = await makeUser(t.tenantId, 'forgetful@su.test', ['Approver', 'Submitter'], 'Forgetful');
    const session = refreshCookie(await login(t.slug, 'forgetful@su.test'));

    expect((await request(app).post(`${api}/admin/users/${userId}/reset-key`).set(bearer((await login(t.slug, 'forgetful@su.test')).body.accessToken))).status).toBe(403);
    expect((await request(app).post(`${api}/admin/users/${userId}/reset-key`).set(bearer(adminToken))).status).toBe(204);

    expect((await request(app).post(`${api}/auth/refresh`).set('Cookie', session)).status).toBe(401);
    expect((await login(t.slug, 'forgetful@su.test', PASSWORD)).status).toBe(401);
    const list = (await request(app).get(`${api}/admin/users`).set(bearer(adminToken))).body.users;
    expect(list.find((u: { userId: number }) => u.userId === userId).hasKey).toBe(false);

    const s = await start('forgetful@su.test');
    expect(s.body).toEqual({ next: 'setup', verification: true, needsName: false, displayName: 'Forgetful' });
    const done = await setup({ email: 'forgetful@su.test', code: await emailedCode('forgetful@su.test'), passwordKey: '730915' });
    expect(done.status).toBe(201);
    expect(done.body.user.userId).toBe(userId);
    expect(done.body.user.roles.sort()).toEqual(['Approver', 'Submitter']);

    const actions = (await tenantQuery<{ Action: string }>(t.tenantId, `SELECT Action FROM AuditLog WHERE TenantId = @TenantId AND EntityType = 'User' AND EntityId = @U ORDER BY AuditId`, { U: userId })).map((a) => a.Action);
    expect(actions).toEqual(expect.arrayContaining(['user.key_reset', 'auth.key_created']));
  });

  it('a deactivated account cannot be re-claimed through setup', async () => {
    const userId = await withTx(async (tx) => createUser(t.tenantId, { email: 'gone@su.test', displayName: 'Gone', roles: ['Approver'], passwordHash: await unusablePasswordHash(), passwordSet: false }, tx));
    await tenantQuery(t.tenantId, 'UPDATE Users SET IsActive = 0 WHERE TenantId = @TenantId AND UserId = @U', { U: userId });
    expect((await start('gone@su.test')).body).toEqual({ next: 'password' });
    expect((await setup({ email: 'gone@su.test', code: '123456', passwordKey: '907351' })).status).toBe(409);
  });
});
