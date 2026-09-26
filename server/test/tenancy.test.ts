import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery, unscopedQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

let a: { tenantId: number; slug: string };
let b: { tenantId: number; slug: string };
let aAdminId: number;
let bAdminId: number;

beforeAll(async () => {
  a = await makeTenant();
  b = await makeTenant();
  // the same email exists in both tenants - they are different accounts
  aAdminId = await makeUser(a.tenantId, 'shared@example.test', ['Admin'], 'A Admin');
  bAdminId = await makeUser(b.tenantId, 'shared@example.test', ['Admin'], 'B Admin');
  await makeUser(a.tenantId, 'submitter@example.test', ['Submitter']);
});
afterAll(closePool);

describe('tenant isolation over the API', () => {
  it('the same email signs in to the tenant named at login, and only that one', async () => {
    const ra = await login(a.slug, 'shared@example.test');
    const rb = await login(b.slug, 'shared@example.test');
    expect(ra.body.user).toMatchObject({ userId: aAdminId, tenantId: a.tenantId, displayName: 'A Admin' });
    expect(rb.body.user).toMatchObject({ userId: bAdminId, tenantId: b.tenantId, displayName: 'B Admin' });
    // a user who exists only in tenant A cannot sign in through tenant B
    expect((await login(b.slug, 'submitter@example.test')).status).toBe(401);
  });

  it('an admin only ever sees and manages users in their own tenant', async () => {
    const tokenA = (await login(a.slug, 'shared@example.test')).body.accessToken;
    const tokenB = (await login(b.slug, 'shared@example.test')).body.accessToken;

    const listA = (await request(app).get('/api/v1/admin/users').set(bearer(tokenA))).body.users.map((u: { email: string }) => u.email);
    const listB = (await request(app).get('/api/v1/admin/users').set(bearer(tokenB))).body.users.map((u: { email: string }) => u.email);
    expect(listA.sort()).toEqual(['shared@example.test', 'submitter@example.test']);
    expect(listB).toEqual(['shared@example.test']);

    // administrators cannot create accounts any more - people register themselves
    const created = await request(app).post('/api/v1/admin/users').set(bearer(tokenA)).send({ email: 'x@example.test', displayName: 'X', roles: ['Approver'] });
    expect(created.status).toBe(404);
    // and one organisation's admin cannot reset a key in another
    expect((await request(app).post(`/api/v1/admin/users/${bAdminId}/reset-key`).set(bearer(tokenA))).status).toBe(404);
  });

  it('enforces roles: a submitter gets 403 on admin endpoints', async () => {
    const token = (await login(a.slug, 'submitter@example.test')).body.accessToken;
    expect((await request(app).get('/api/v1/admin/users').set(bearer(token))).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/users')).status).toBe(401);
  });
});

describe('tenant isolation in the data layer', () => {
  it('tenantQuery refuses statements that do not filter by @TenantId', async () => {
    await expect(tenantQuery(a.tenantId, 'SELECT * FROM Users')).rejects.toThrow(/@TenantId/);
    await expect(tenantQuery(0, 'SELECT * FROM Users WHERE TenantId = @TenantId')).rejects.toThrow(/invalid tenantId/);
    await expect(tenantQuery(a.tenantId, 'SELECT 1 WHERE @TenantId = 1', { TenantId: b.tenantId })).rejects.toThrow(/automatically/);
  });

  it('composite foreign keys block rows that point at another tenant', async () => {
    // tenant B tries to attach a role to tenant A's user
    await expect(
      unscopedQuery(`INSERT INTO UserRoles (TenantId, UserId, Role) VALUES (@T, @U, 'Approver')`, { T: b.tenantId, U: aAdminId }),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('the audit log is append-only, even for a sysadmin connection', async () => {
    await login(a.slug, 'shared@example.test');
    await expect(unscopedQuery('DELETE FROM AuditLog WHERE TenantId = @T', { T: a.tenantId })).rejects.toThrow(/append-only/);
    await expect(unscopedQuery(`UPDATE AuditLog SET Action = 'x' WHERE TenantId = @T`, { T: a.tenantId })).rejects.toThrow(/append-only/);
    const [row] = await tenantQuery<{ IpAddress: string | null; UserId: number }>(
      a.tenantId,
      `SELECT TOP 1 IpAddress, UserId FROM AuditLog WHERE TenantId = @TenantId AND Action = 'auth.login' ORDER BY AuditId DESC`,
    );
    expect(row.UserId).toBe(aAdminId);
    expect(row.IpAddress).toBeTruthy();
  });
});
