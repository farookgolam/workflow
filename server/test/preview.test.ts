import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let lookupId: number;
const tok: Record<string, string> = {};
const post = (as: string, url: string, body: unknown) => request(app).post(`${api}/admin/forms/preview${url}`).set(bearer(tok[as])).send(body as object);

const fields = () => [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'school', label: 'School', type: 'lookup', required: true, props: { lookupId } },
  { key: 'secretary', label: 'Secretary', type: 'text', props: { lookupFrom: 'school', lookupColumn: 'Secretary' } },
  { key: 'note', label: 'Read me', type: 'paragraph', props: { text: 'hello' } },
];

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ava: ['Approver'], bob: ['Approver'] } as const)) {
    await makeUser(t.tenantId, `${name}@pv.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@pv.test`)).body.accessToken;
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('S');
  [['School', 'Secretary', 'Private'], ['North', 'Pat Lee', 'x'], ['South', 'Sam Roy', 'y']].forEach((r) => ws.addRow(r));
  const res = await request(app).post(`${api}/admin/lookups/import?name=S&keyColumn=School`).set(bearer(tok.admin)).set('Content-Type', 'application/octet-stream').send(Buffer.from(await wb.xlsx.writeBuffer()));
  lookupId = res.body.lookupId;
});
afterAll(closePool);

describe('form builder preview (nothing is saved)', () => {
  it('serves the lookup data an UNSAVED form would use, with the usual column filtering', async () => {
    expect((await post('sam', '/lookups', { fields: fields() })).status).toBe(403);
    const res = await post('admin', '/lookups', { fields: fields() });
    expect(res.body.lookups[lookupId].rows).toEqual([{ key: 'North', data: { Secretary: 'Pat Lee' } }, { key: 'South', data: { Secretary: 'Sam Roy' } }]);

    const broken = fields().map((f) => (f.key === 'secretary' ? { ...f, props: { lookupFrom: 'school', lookupColumn: 'Nope' } } : f));
    expect((await post('admin', '/lookups', { fields: broken })).body.error.details[0].message).toMatch(/no column "Nope"/);
  });

  it('test submit runs the real validation and auto-fill, reports what would be stored, and writes nothing', async () => {
    const before = (await tenantQuery<{ n: number }>(t.tenantId, 'SELECT (SELECT COUNT(*) FROM Requests WHERE TenantId = @TenantId) + (SELECT COUNT(*) FROM Forms WHERE TenantId = @TenantId) AS n'))[0].n;

    const bad = await post('admin', '/validate', { fields: fields(), values: { school: 'West' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['name', 'school']);

    const ok = await post('admin', '/validate', { fields: fields(), values: { name: 'Ann', school: 'south', secretary: 'Forged' } });
    expect(ok.body.stored).toEqual([
      { key: 'name', label: 'Name', type: 'text', value: 'Ann', autoFilled: false },
      { key: 'school', label: 'School', type: 'lookup', value: 'South', autoFilled: false },
      { key: 'secretary', label: 'Secretary', type: 'text', value: 'Sam Roy', autoFilled: true },
    ]);

    const after = (await tenantQuery<{ n: number }>(t.tenantId, 'SELECT (SELECT COUNT(*) FROM Requests WHERE TenantId = @TenantId) + (SELECT COUNT(*) FROM Forms WHERE TenantId = @TenantId) AS n'))[0].n;
    expect(after).toBe(before);
  });

  it('chain preview works out who an UNSAVED step goes to, as for a real request, and writes nothing', async () => {
    const id = async (email: string) => (await tenantQuery<{ UserId: number }>(t.tenantId, 'SELECT UserId FROM Users WHERE TenantId = @TenantId AND Email = @E', { E: email }))[0].UserId;
    const [ava, bob, sam] = [await id('ava@pv.test'), await id('bob@pv.test'), await id('sam@pv.test')];
    const before = (await tenantQuery<{ n: number }>(t.tenantId, 'SELECT COUNT(*) AS n FROM Users WHERE TenantId = @TenantId'))[0].n;

    expect((await post('sam', '/handoff', { step: { name: 'Boss', approverUserId: ava }, stepOrder: 1 })).status).toBe(403);
    const fixed = await post('admin', '/handoff', { step: { name: 'Boss', approverUserId: ava }, stepOrder: 1 });
    expect(fixed.body).toMatchObject({ stepOrder: 1, name: 'Boss', mode: 'fixed', approver: { userId: ava, displayName: 'AVA' }, candidates: [] });

    const notApprover = await post('admin', '/handoff', { step: { name: 'Boss', approverUserId: sam }, stepOrder: 1 });
    expect(notApprover.status).toBe(400);
    expect(notApprover.body.error.details[0].message).toMatch(/Approver role/);

    // chosen from every approver: never the person handing on or the submitter
    const anyone = await post('admin', '/handoff', { step: { name: 'Pick', chosen: {} }, stepOrder: 2, excludeUserIds: [ava, sam] });
    const ids = anyone.body.candidates.map((c: { userId: number }) => c.userId);
    expect(ids).toContain(bob);
    expect(ids).not.toContain(ava);

    // chosen from a lookup file: a missing email column is reported, not guessed
    const list = await post('admin', '/handoff', { step: { name: 'Pick', chosen: { lookupId, emailColumn: 'Nope' } }, stepOrder: 2 });
    expect(list.status).toBe(400);
    expect(list.body.error.details[0].message).toMatch(/email/);

    expect((await tenantQuery<{ n: number }>(t.tenantId, 'SELECT COUNT(*) AS n FROM Users WHERE TenantId = @TenantId'))[0].n).toBe(before);
  });
});
