import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let admin: string;
let submitter: string;

async function sheet(rows: (string | null)[][], headings = ['Email', 'Name', 'Roles']): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Users');
  ws.addRow(headings);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const importSheet = (file: Buffer, query: string) =>
  request(app).post(`${api}/admin/users/import?${query}`).set(bearer(admin)).set('Content-Type', 'application/octet-stream').send(file);
const account = async (email: string) =>
  (await tenantQuery<{ UserId: number; HasKey: number; Roles: string | null }>(
    t.tenantId,
    `SELECT u.UserId, CASE WHEN u.PasswordSetAt IS NULL THEN 0 ELSE 1 END AS HasKey,
            (SELECT STRING_AGG(r.Role, ',') WITHIN GROUP (ORDER BY r.Role) FROM UserRoles r WHERE r.TenantId = u.TenantId AND r.UserId = u.UserId) AS Roles
       FROM Users u WHERE u.TenantId = @TenantId AND u.Email = @E`,
    { E: email },
  ))[0];
const welcomes = async (email: string) =>
  (await tenantQuery<{ n: number }>(t.tenantId, `SELECT COUNT(*) AS n FROM Notifications WHERE TenantId = @TenantId AND Type = 'AccountCreated' AND RecipientEmail = @E`, { E: email }))[0].n;

beforeAll(async () => {
  t = await makeTenant();
  await makeUser(t.tenantId, 'admin@add.test', ['Admin']);
  await makeUser(t.tenantId, 'sam@add.test', ['Submitter']);
  admin = (await login(t.slug, 'admin@add.test')).body.accessToken;
  submitter = (await login(t.slug, 'sam@add.test')).body.accessToken;
});
afterAll(closePool);

describe('administrators adding people', () => {
  it('adds one person with roles and no key; they are emailed how to sign in', async () => {
    const res = await request(app).post(`${api}/admin/users`).set(bearer(admin)).send({ email: 'Ann.Approver@Add.test', displayName: 'Ann Approver', roles: ['Approver', 'Submitter'] });
    expect(res.status).toBe(201);
    expect(await account('ann.approver@add.test')).toMatchObject({ HasKey: 0, Roles: 'Approver,Submitter' });
    expect(await welcomes('ann.approver@add.test')).toBe(1);

    // they cannot sign in with any key until they create their own
    expect((await login(t.slug, 'ann.approver@add.test')).status).toBe(401);

    const again = await request(app).post(`${api}/admin/users`).set(bearer(admin)).send({ email: 'ann.approver@add.test', displayName: 'Twice', roles: ['Submitter'] });
    expect(again.status).toBe(409);
  });

  it('can skip the welcome email', async () => {
    await request(app).post(`${api}/admin/users`).set(bearer(admin)).send({ email: 'quiet@add.test', displayName: 'Quiet One', roles: ['Submitter'], sendEmail: false });
    expect(await welcomes('quiet@add.test')).toBe(0);
  });

  it('only administrators can add people', async () => {
    expect((await request(app).post(`${api}/admin/users`).set(bearer(submitter)).send({ email: 'x@add.test', displayName: 'X X', roles: ['Submitter'] })).status).toBe(403);
    expect((await request(app).post(`${api}/admin/users/import`).set(bearer(submitter)).set('Content-Type', 'application/octet-stream').send(await sheet([['y@add.test', 'Y Y', '']]))).status).toBe(403);
  });

  it('bulk import: a dry run reports each row and changes nothing; the real run adds the valid new rows', async () => {
    const file = await sheet([
      ['bob@add.test', 'Bob Builder', 'Approver'],
      ['CAT@add.test', 'Cat Admin', 'approver, admin'],
      ['dan@add.test', 'Dan Default', null],
      ['sam@add.test', 'Sam Existing', 'Submitter'],
      ['not-an-email', 'Bad Email', ''],
      ['eve@add.test', 'Eve', 'Boss'],
      ['bob@add.test', 'Bob Again', ''],
      ['fay@add.test', '', ''],
    ]);

    const dry = await importSheet(file, 'dryRun=1');
    expect(dry.status).toBe(200);
    expect(dry.body.summary).toEqual({ rows: 8, add: 3, added: 0, exists: 1, errors: 4 });
    expect(dry.body.rows.map((r: { row: number; status: string }) => `${r.row}:${r.status}`)).toEqual(['2:add', '3:add', '4:add', '5:exists', '6:error', '7:error', '8:error', '9:error']);
    expect(dry.body.rows[1]).toMatchObject({ email: 'cat@add.test', roles: ['Approver', 'Admin'] });
    expect(dry.body.rows[2].roles).toEqual(['Submitter']);
    expect(await account('bob@add.test')).toBeUndefined();

    const real = await importSheet(file, 'dryRun=0&sendEmail=1');
    expect(real.body.summary).toMatchObject({ added: 3, exists: 1, errors: 4 });
    expect(await account('bob@add.test')).toMatchObject({ HasKey: 0, Roles: 'Approver' });
    expect(await account('cat@add.test')).toMatchObject({ Roles: 'Admin,Approver' });
    expect(await welcomes('dan@add.test')).toBe(1);

    // importing the same sheet again adds nobody
    expect((await importSheet(file, 'dryRun=0')).body.summary).toMatchObject({ added: 0, exists: 4 });

    const logged = await tenantQuery<{ Action: string }>(t.tenantId, `SELECT Action FROM AuditLog WHERE TenantId = @TenantId AND Action IN ('user.created','users.imported')`);
    expect(logged.filter((a) => a.Action === 'users.imported')).toHaveLength(1);
  });

  it('refuses a sheet without Email and Name headings, and a file that is not Excel', async () => {
    const wrong = await importSheet(await sheet([['a@add.test', 'A A']], ['Mail', 'Who']), 'dryRun=1');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('bad_headings');
    expect((await importSheet(Buffer.from('email,name\na@add.test,A A'), 'dryRun=1')).body.error.code).toBe('not_xlsx');
  });

  it('the downloadable template imports as-is', async () => {
    const tpl = await request(app).get(`${api}/admin/users/import-template`).set(bearer(admin)).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(tpl.status).toBe(200);
    const dry = await importSheet(tpl.body as Buffer, 'dryRun=1');
    expect(dry.body.summary).toMatchObject({ rows: 3, add: 3, errors: 0 });
  });
});
