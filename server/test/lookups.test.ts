import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

async function xlsx(rows: unknown[][], extraSheet = false): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Schools');
  rows.forEach((r) => ws.addRow(r));
  if (extraSheet) wb.addWorksheet('Notes').addRow(['ignore me']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const upload = (method: 'post' | 'put', url: string, file: Buffer, as = 'admin') =>
  request(app)[method](`${api}/admin/lookups${url}`).set(bearer(tok[as])).set('Content-Type', 'application/octet-stream').send(file);

const SCHOOLS = [
  ['School', 'Department', 'Secretary', 'Email', 'Salary band'],
  ['Hawes Elementary', 'Elementary', 'Pat Lee', 'pat.lee@example.org', 'B2'],
  ['Ridge Elementary', 'Elementary', 'Sam Roy', 'sam.roy@example.org', 'B3'],
  ['George Washington MS', 'Middle School', { formula: '"Dana "&"Kim"', result: 'Dana Kim' }, 'dana.kim@example.org', 'C1'],
];

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ann: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@lk.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@lk.test`)).body.accessToken;
  }
});
afterAll(closePool);

describe('importing an Excel lookup', () => {
  it('previews the file, then imports it with a chosen key column', async () => {
    const file = await xlsx(SCHOOLS, true);
    expect((await upload('post', '/parse', file, 'sam')).status).toBe(403);

    const preview = await upload('post', '/parse', file);
    expect(preview.body).toMatchObject({ sheetName: 'Schools', columns: SCHOOLS[0], rowCount: 3 });
    expect(preview.body.sample[2].Secretary).toBe('Dana Kim'); // formula -> its value
    expect(preview.body.warnings[0]).toMatch(/2 sheets/);

    const imported = await upload('post', '/import?name=Schools&keyColumn=School&fileName=schools.xlsx', file);
    expect(imported.status).toBe(201);
    expect(imported.body.rows).toBe(3);

    const list = (await request(app).get(`${api}/admin/lookups`).set(bearer(tok.admin))).body.lookups;
    expect(list).toEqual([expect.objectContaining({ name: 'Schools', keyColumn: 'School', rows: 3, columns: SCHOOLS[0], usedBy: [] })]);
    const detail = (await request(app).get(`${api}/admin/lookups/${imported.body.lookupId}`).set(bearer(tok.admin))).body;
    expect(detail.sample[0]).toEqual({ School: 'Hawes Elementary', Department: 'Elementary', Secretary: 'Pat Lee', Email: 'pat.lee@example.org', 'Salary band': 'B2' });

    expect((await upload('post', '/import?name=Schools&keyColumn=School', file)).body.error.code).toBe('name_taken');
  });

  it('refuses files it cannot use, with a reason the admin can act on', async () => {
    const code = async (res: Promise<request.Response>) => (await res).body.error.code;
    expect(await code(upload('post', '/parse', Buffer.from('School,Dept\nA,B')))).toBe('not_xlsx'); // a CSV renamed or otherwise
    expect(await code(upload('post', '/parse', Buffer.from('PK not really a zip')))).toBe('not_xlsx');
    expect(await code(upload('post', '/parse', await xlsx([['Only headings']])))).toBe('no_rows');
    expect(await code(upload('post', '/parse', await xlsx([['A', 'a'], ['1', '2']])))).toBe('duplicate_column');
    expect(await code(upload('post', '/import?name=X&keyColumn=Nope', await xlsx(SCHOOLS)))).toBe('bad_key_column');
    expect(await code(upload('post', '/import?name=X&keyColumn=Department', await xlsx(SCHOOLS)))).toBe('duplicate_keys');
    expect(await code(upload('post', '/import?name=X&keyColumn=School', await xlsx([['School', 'D'], ['', 'x'], ['B', 'y']])))).toBe('blank_keys');
    expect((await upload('post', '/parse', Buffer.alloc(0))).status).toBe(400);
  });
});

describe('lookup controls on a form', () => {
  let lookupId: number;
  let formId: number;
  const fields = () => [
    { key: 'title', label: 'Title', type: 'text', required: true },
    { key: 'school', label: 'School', type: 'lookup', required: true, props: { lookupId, width: 6 } },
    { key: 'department', label: 'Department', type: 'text', props: { lookupFrom: 'school', lookupColumn: 'Department', width: 6 } },
    { key: 'secretaryEmail', label: 'Secretary email', type: 'email', props: { lookupFrom: 'school', lookupColumn: 'Email' } },
  ];

  beforeAll(async () => {
    lookupId = (await request(app).get(`${api}/admin/lookups`).set(bearer(tok.admin))).body.lookups[0].lookupId;
    const created = await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Timesheet', slug: 'timesheet', fields: fields() });
    expect(created.status).toBe(201);
    formId = created.body.formId;
    await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Secretary', approverUserId: ids.ann }] });
  });

  it('rejects broken lookup configuration when the form is saved', async () => {
    const save = (f: unknown[]) => request(app).put(`${api}/admin/forms/${formId}/fields`).set(bearer(tok.admin)).send({ fields: f });
    const base = fields();
    expect((await save([base[0], { ...base[1], props: {} }])).body.error.details[0].message).toMatch(/choose which lookup table/);
    expect((await save([base[0], { ...base[1], props: { lookupId: 999999 } }])).body.error.details[0].message).toMatch(/no longer exists/);
    expect((await save([base[0], base[1], { ...base[2], props: { lookupFrom: 'school', lookupColumn: 'Nope' } }])).body.error.details[0].message).toMatch(/no column "Nope"/);
    expect((await save([base[0], base[1], { ...base[2], props: { lookupFrom: 'title', lookupColumn: 'Department' } }])).body.error.details[0].message).toMatch(/choose the lookup control/);
    expect((await save([base[0], base[1], { key: 'd', label: 'D', type: 'date', props: { lookupFrom: 'school', lookupColumn: 'Department' } }])).body.error.details[0].message).toMatch(/cannot be filled/);
    expect((await save(base)).status).toBe(204);
  });

  it('gives the person filling the form the keys and ONLY the columns the form uses', async () => {
    const res = (await request(app).get(`${api}/forms/${formId}`).set(bearer(tok.sam))).body;
    const rows = res.lookups[lookupId].rows;
    expect(rows.map((r: { key: string }) => r.key)).toEqual(['Hawes Elementary', 'Ridge Elementary', 'George Washington MS']);
    expect(rows[0].data).toEqual({ Department: 'Elementary', Email: 'pat.lee@example.org' });
    expect(JSON.stringify(res)).not.toMatch(/Salary band|B2|Pat Lee/); // unused columns never leave the server
  });

  it('computes auto-filled values on the server and ignores whatever the browser sends for them', async () => {
    const submit = (values: Record<string, unknown>) => request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values });

    expect((await submit({ title: 'x', school: 'Hogwarts' })).body.error.details[0]).toEqual({ path: 'school', message: 'School is not one of the available choices' });
    expect((await submit({ title: 'x' })).body.error.details[0].message).toBe('School is required');

    const forged = await submit({ title: 'Week 38', school: 'george washington ms', department: 'Superintendent', secretaryEmail: 'attacker@evil.test' });
    expect(forged.status).toBe(201);
    const stored = Object.fromEntries((await tenantQuery<{ FieldKey: string; Value: string }>(t.tenantId, 'SELECT FieldKey, Value FROM RequestData WHERE TenantId = @TenantId AND RequestId = @R', { R: forged.body.requestId })).map((r) => [r.FieldKey, r.Value]));
    expect(stored).toEqual({ title: 'Week 38', school: 'George Washington MS', department: 'Middle School', secretaryEmail: 'dana.kim@example.org' });
  });

  it('replacing the spreadsheet updates new requests but never past ones, and must keep the columns forms use', async () => {
    const before = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { title: 'Before', school: 'Hawes Elementary' } });

    const missingColumn = await upload('put', `/${lookupId}/import`, await xlsx([['School', 'Department'], ['Hawes Elementary', 'Primary']]));
    expect(missingColumn.body.error).toMatchObject({ code: 'columns_in_use', message: expect.stringContaining('Email') });

    const replaced = await upload('put', `/${lookupId}/import?fileName=schools-2027.xlsx`, await xlsx([['School', 'Department', 'Email'], ['Hawes Elementary', 'Primary', 'office@hawes.example.org'], ['New Academy', 'High School', 'office@new.example.org']]));
    expect(replaced.body.rows).toBe(2);

    const after = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { title: 'After', school: 'Hawes Elementary' } });
    const dept = async (requestId: number) => (await tenantQuery<{ Value: string }>(t.tenantId, `SELECT Value FROM RequestData WHERE TenantId = @TenantId AND RequestId = @R AND FieldKey = 'department'`, { R: requestId }))[0].Value;
    expect(await dept(before.body.requestId)).toBe('Elementary');
    expect(await dept(after.body.requestId)).toBe('Primary');
    expect((await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { title: 'Gone', school: 'Ridge Elementary' } })).status).toBe(400);
  });

  it('cannot be deleted while a form uses it, and is invisible to other organisations', async () => {
    const del = await request(app).delete(`${api}/admin/lookups/${lookupId}`).set(bearer(tok.admin));
    expect(del.body.error).toMatchObject({ code: 'in_use', message: expect.stringContaining('Timesheet') });

    const other = await makeTenant();
    await makeUser(other.tenantId, 'root@lk-other.test', ['Admin']);
    const otherTok = (await login(other.slug, 'root@lk-other.test')).body.accessToken;
    expect((await request(app).get(`${api}/admin/lookups`).set(bearer(otherTok))).body.lookups).toEqual([]);
    expect((await request(app).get(`${api}/admin/lookups/${lookupId}`).set(bearer(otherTok))).status).toBe(404);
    expect((await request(app).post(`${api}/admin/forms`).set(bearer(otherTok)).send({ name: 'Steal', slug: 'steal', fields: [{ key: 's', label: 'S', type: 'lookup', props: { lookupId } }] })).status).toBe(400);

    await request(app).delete(`${api}/admin/forms/${formId}`).set(bearer(tok.admin)); // form removed from the repository...
    expect((await request(app).delete(`${api}/admin/lookups/${lookupId}`).set(bearer(tok.admin))).status).toBe(204); // ...so the lookup is free
  });
});

describe('adding a row by hand', () => {
  it('adds a row at the end, which forms can use straight away', async () => {
    const imported = await upload('post', '/import?name=Schools%20to%20extend&keyColumn=School', await xlsx(SCHOOLS));
    const id = imported.body.lookupId;
    const add = (values: Record<string, string>, as = 'admin') => request(app).post(`${api}/admin/lookups/${id}/rows`).set(bearer(tok[as])).send({ values });

    const added = await add({ School: '  Lincoln High  ', Department: 'High School', Secretary: 'Ari Moss', Email: 'ari.moss@example.org' });
    expect(added.status).toBe(201);
    expect(added.body.row).toEqual({ School: 'Lincoln High', Department: 'High School', Secretary: 'Ari Moss', Email: 'ari.moss@example.org', 'Salary band': '' });

    const detail = (await request(app).get(`${api}/admin/lookups/${id}`).set(bearer(tok.admin))).body;
    expect(detail.rows).toBe(4);
    expect(detail.sample.at(-1)).toMatchObject({ School: 'Lincoln High', Secretary: 'Ari Moss' });

    // a form's lookup control offers it, and auto-fill reads its columns
    const preview = await request(app).post(`${api}/admin/forms/preview/lookups`).set(bearer(tok.admin)).send({
      fields: [
        { key: 'school', label: 'School', type: 'lookup', props: { lookupId: id } },
        { key: 'secretary', label: 'Secretary', type: 'text', props: { lookupFrom: 'school', lookupColumn: 'Secretary' } },
      ],
    });
    expect(preview.body.lookups[id].rows.at(-1)).toEqual({ key: 'Lincoln High', data: { Secretary: 'Ari Moss' } });

    const [logged] = await tenantQuery<{ Action: string }>(t.tenantId, `SELECT TOP 1 Action FROM AuditLog WHERE TenantId = @TenantId AND EntityType = 'Lookup' AND EntityId = @L ORDER BY AuditId DESC`, { L: id });
    expect(logged.Action).toBe('lookup.row_added');
  });

  it('refuses a missing or repeated key, unknown columns, and anyone but an administrator', async () => {
    const imported = await upload('post', '/import?name=Schools%20strict&keyColumn=School', await xlsx(SCHOOLS));
    const id = imported.body.lookupId;
    const add = (values: Record<string, string>, as = 'admin') => request(app).post(`${api}/admin/lookups/${id}/rows`).set(bearer(tok[as])).send({ values });

    expect((await add({ School: '   ', Department: 'X' })).body.error.code).toBe('blank_key');
    expect((await add({ School: 'hawes elementary' })).body.error.code).toBe('duplicate_key'); // capitals don't make it different
    expect((await add({ School: 'New', Principal: 'Someone' })).body.error.code).toBe('unknown_column');
    expect((await add({ School: 'New' }, 'sam')).status).toBe(403);
    expect((await request(app).post(`${api}/admin/lookups/999999/rows`).set(bearer(tok.admin)).send({ values: { School: 'x' } })).status).toBe(404);
    expect((await request(app).get(`${api}/admin/lookups/${id}`).set(bearer(tok.admin))).body.rows).toBe(3); // nothing was added
  });
});

describe('finding, changing and deleting rows', () => {
  it('finds rows by any cell, edits one in place and deletes another', async () => {
    const imported = await upload('post', '/import?name=Schools%20to%20edit&keyColumn=School', await xlsx(SCHOOLS));
    const id = imported.body.lookupId;
    const get = (q = '') => request(app).get(`${api}/admin/lookups/${id}${q ? `?q=${encodeURIComponent(q)}` : ''}`).set(bearer(tok.admin));

    const found = (await get('sam.roy')).body;
    expect(found).toMatchObject({ rows: 3, matches: 1 });
    expect(found.sample).toEqual([expect.objectContaining({ School: 'Ridge Elementary' })]);
    expect((await get('100%')).body.matches).toBe(0); // wildcards are taken literally

    const all = (await get()).body;
    const idOf = (school: string) => all.rowIds[all.sample.findIndex((r: { School: string }) => r.School === school)];

    // edit: new secretary and a renamed key; the row keeps its place
    const edited = await request(app).put(`${api}/admin/lookups/${id}/rows/${idOf('Ridge Elementary')}`).set(bearer(tok.admin))
      .send({ values: { School: 'Ridge Elementary School', Department: 'Elementary', Secretary: 'Jo Park', Email: 'jo.park@example.org', 'Salary band': 'B3' } });
    expect(edited.status).toBe(200);
    const afterEdit = (await get()).body;
    expect(afterEdit.sample.map((r: { School: string }) => r.School)).toEqual(['Hawes Elementary', 'Ridge Elementary School', 'George Washington MS']);
    expect(afterEdit.sample[1].Secretary).toBe('Jo Park');

    // an edit may keep its own key, but not take another row's
    expect((await request(app).put(`${api}/admin/lookups/${id}/rows/${idOf('Hawes Elementary')}`).set(bearer(tok.admin)).send({ values: { School: 'HAWES ELEMENTARY' } })).status).toBe(200);
    expect((await request(app).put(`${api}/admin/lookups/${id}/rows/${idOf('Hawes Elementary')}`).set(bearer(tok.admin)).send({ values: { School: 'george washington ms' } })).body.error.code).toBe('duplicate_key');

    // delete
    expect((await request(app).delete(`${api}/admin/lookups/${id}/rows/${idOf('George Washington MS')}`).set(bearer(tok.admin))).status).toBe(204);
    const afterDelete = (await get()).body;
    expect(afterDelete.rows).toBe(2);
    expect(afterDelete.sample.map((r: { School: string }) => r.School)).toEqual(['HAWES ELEMENTARY', 'Ridge Elementary School']);
    expect((await request(app).delete(`${api}/admin/lookups/${id}/rows/${idOf('George Washington MS')}`).set(bearer(tok.admin))).status).toBe(404);

    const actions = await tenantQuery<{ Action: string }>(t.tenantId, `SELECT Action FROM AuditLog WHERE TenantId = @TenantId AND EntityType = 'Lookup' AND EntityId = @L ORDER BY AuditId`, { L: id });
    expect(actions.map((a) => a.Action)).toEqual(['lookup.imported', 'lookup.row_updated', 'lookup.row_updated', 'lookup.row_deleted']);
  });

  it('only administrators, and only rows of that table', async () => {
    const a = (await upload('post', '/import?name=Table%20A&keyColumn=School', await xlsx(SCHOOLS))).body.lookupId;
    const b = (await upload('post', '/import?name=Table%20B&keyColumn=School', await xlsx(SCHOOLS))).body.lookupId;
    const rowOfA = (await request(app).get(`${api}/admin/lookups/${a}`).set(bearer(tok.admin))).body.rowIds[0];

    expect((await request(app).delete(`${api}/admin/lookups/${a}/rows/${rowOfA}`).set(bearer(tok.sam))).status).toBe(403);
    expect((await request(app).delete(`${api}/admin/lookups/${b}/rows/${rowOfA}`).set(bearer(tok.admin))).status).toBe(404); // a row of another table
    expect((await request(app).put(`${api}/admin/lookups/${b}/rows/${rowOfA}`).set(bearer(tok.admin)).send({ values: { School: 'x' } })).status).toBe(404);
    expect((await request(app).get(`${api}/admin/lookups/${a}`).set(bearer(tok.admin))).body.rows).toBe(3);
  });
});
