import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processArchive } from '../src/archive/worker';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { evalFormula, parseFormula } from '../src/forms/formula';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

const columns = [
  { key: 'item', label: 'Item', type: 'text', required: true },
  { key: 'category', label: 'Category', type: 'select', options: ['Goods', 'Services'] },
  { key: 'qty', label: 'Qty', type: 'number', total: true },
  { key: 'price', label: 'Unit price', type: 'currency' },
  { key: 'amount', label: 'Amount', type: 'calc', formula: 'qty * price', total: true },
  { key: 'withTax', label: 'With tax', type: 'calc', formula: 'round(amount * 1.13, 1)', decimals: 1 },
];
const fields = [
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'items', label: 'Items', type: 'grid', required: true, props: { columns, minRows: 1, maxRows: 3 } },
];
const submit = (values: Record<string, unknown>) => request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values });
const make = (field: Record<string, unknown>) => request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Bad', slug: `bad-${Math.random().toString(36).slice(2)}`, fields: [field] });

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ann: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@grid.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@grid.test`)).body.accessToken;
  }
  const created = await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Order', slug: 'order', fields });
  expect(created.status).toBe(201);
  formId = created.body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Check', approverUserId: ids.ann, fields: [] }] });
});
afterAll(closePool);

describe('formulas', () => {
  const run = (f: string, vars: Record<string, number | null> = {}) => evalFormula(parseFormula(f), vars);
  it('follows arithmetic precedence, brackets, unary minus and functions', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * -3')).toBe(-9);
    expect(run('round(10 / 3, 2)')).toBe(3.33);
    expect(run('max(a, b) - min(a, b) + abs(-1)', { a: 2, b: 5 })).toBe(4);
    expect(run('elapsed(a, b)', { a: 9, b: 17.5 })).toBe(8.5);
    expect(run('elapsed(a, b)', { a: 22, b: 6 })).toBe(8); // past midnight
  });
  it('treats a blank cell as 0, but gives nothing when every cell it reads is blank or the result is not a number', () => {
    expect(run('a + b', { a: 4, b: null })).toBe(4);
    expect(run('a * b', { a: null, b: null })).toBeNull();
    expect(run('a / b', { a: 1, b: 0 })).toBeNull();
  });
  it('refuses anything that is not arithmetic', () => {
    // "quoted text" and comparisons like a = 1 are formulas now (see formula-functions.test.ts)
    for (const bad of ['', '1 +', '(1', 'a b', 'alert(1)', 'a.b.c', 'process.exit()', '1; 2', 'a == 1', 'round()']) expect(() => parseFormula(bad), bad).toThrow();
    // one dot is a name: a form formula reads a data grid column's total as grid.column (grid columns themselves refuse it, see below)
    expect(parseFormula('items.amount')).toEqual({ t: 'ref', name: 'items.amount' });
  });
});

describe('data grid control', () => {
  it('keeps its column definitions', async () => {
    const got = (await request(app).get(`${api}/forms/${formId}`).set(bearer(tok.sam))).body.fields.find((f: { key: string }) => f.key === 'items');
    expect(got.props).toEqual({ columns, minRows: 1, maxRows: 3 });
  });

  it('rejects bad column definitions', async () => {
    const grid = (cols: unknown, extra: Record<string, unknown> = {}) => make({ key: 'g', label: 'G', type: 'grid', props: { columns: cols, ...extra } });
    expect((await make({ key: 'g', label: 'G', type: 'grid' })).status).toBe(400); // no columns
    expect((await make({ key: 'g', label: 'G', type: 'text', props: { columns } })).status).toBe(400); // columns on another control
    expect((await grid([{ key: 'a', label: 'A', type: 'number' }, { key: 'a', label: 'B', type: 'number' }])).status).toBe(400); // duplicate key
    expect((await grid([{ key: 'a', label: 'A', type: 'calc', formula: '1 + 1' }])).status).toBe(400); // nothing to fill in
    expect((await grid([{ key: 'a', label: 'A', type: 'select' }])).status).toBe(400); // no options
    expect((await grid([{ key: 'a', label: 'A', type: 'number' }, { key: 'c', label: 'C', type: 'calc' }])).status).toBe(400); // no formula
    expect((await grid([{ key: 'a', label: 'A', type: 'number' }, { key: 'c', label: 'C', type: 'calc', formula: 'a *' }])).status).toBe(400); // broken formula
    expect((await grid([{ key: 'a', label: 'A', type: 'text' }, { key: 'c', label: 'C', type: 'calc', formula: 'a * 2' }])).status).toBe(400); // reads a text column
    expect((await grid([{ key: 'a', label: 'A', type: 'number' }, { key: 'c', label: 'C', type: 'calc', formula: 'g.a * 2' }])).status).toBe(400); // grid.column is for form formulas, not cells
    expect((await grid([{ key: 'c', label: 'C', type: 'calc', formula: 'a * 2' }, { key: 'a', label: 'A', type: 'number' }])).status).toBe(201); // may read any number column...
    expect((await grid([{ key: 'a', label: 'A', type: 'number' }, { key: 'c', label: 'C', type: 'calc', formula: 'd' }, { key: 'd', label: 'D', type: 'calc', formula: 'a' }])).status).toBe(400); // ...but only earlier calculated ones
    expect((await grid([{ key: 'a', label: 'A', type: 'number' }], { minRows: 5, maxRows: 2 })).status).toBe(400);
    const message = (await grid([{ key: 'a', label: 'A', type: 'number' }, { key: 'c', label: 'Sum', type: 'calc', formula: 'a + nope' }])).body.error.details[0].message;
    expect(message).toContain('"nope"');
  });

  it('calculates cells and totals on the server, ignoring what the browser sent for them, and drops empty rows', async () => {
    const res = await submit({
      items: [
        { item: ' Paper ', category: 'Goods', qty: 3, price: 4.5, amount: 999999, withTax: 1 },
        { item: '', qty: '' },
        { item: 'Audit', category: 'Services', qty: '2', price: '100.25' },
        { item: 'Free sample' },
      ],
    });
    expect(res.status).toBe(201);
    const [stored] = await tenantQuery<{ Value: string }>(t.tenantId, "SELECT Value FROM RequestData WHERE TenantId = @TenantId AND RequestId = @R AND FieldKey = 'items'", { R: res.body.requestId });
    expect(JSON.parse(stored.Value)).toEqual({
      columns: columns.map(({ key, label, type }) => ({ key, label, type })),
      rows: [
        { item: 'Paper', category: 'Goods', qty: '3', price: '4.50', amount: '13.50', withTax: '15.3' },
        { item: 'Audit', category: 'Services', qty: '2', price: '100.25', amount: '200.50', withTax: '226.6' },
        { item: 'Free sample', category: null, qty: null, price: null, amount: null, withTax: null },
      ],
      totals: { qty: '5', amount: '214.00' },
    });

    // approvers get the same snapshot, and the PDF is built from it
    const [step] = await tenantQuery<{ RequestStepId: number }>(t.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R', { R: res.body.requestId });
    const page = (await request(app).get(`${api}/approvals/${step.RequestStepId}`).set(bearer(tok.ann))).body;
    expect(page.submission.find((f: { key: string }) => f.key === 'items')).toMatchObject({ type: 'grid', value: stored.Value });
    await request(app).post(`${api}/approvals/${step.RequestStepId}/decision`).set(bearer(tok.ann)).send({ decision: 'approve' });
    const done = await processArchive({ tenantId: t.tenantId });
    expect(done.generated).toBe(1);
  });

  it('reads a time column as hours, so two times can be subtracted', async () => {
    const cols = [
      { key: 'day', label: 'Day', type: 'date' },
      { key: 'timeIn', label: 'Time in', type: 'time', required: true },
      { key: 'timeOut', label: 'Time out', type: 'time', required: true },
      { key: 'breakHours', label: 'Break (h)', type: 'number' },
      { key: 'hours', label: 'Hours', type: 'calc', formula: 'timeOut - timeIn - breakHours', total: true },
      { key: 'shift', label: 'Shift', type: 'calc', formula: 'elapsed(timeIn, timeOut)' },
      { key: 'pay', label: 'Pay', type: 'calc', formula: 'hours * 20', total: true },
    ];
    const created = await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Timesheet', slug: 'timesheet', fields: [{ key: 'times', label: 'Times', type: 'grid', props: { columns: cols } }] });
    expect(created.status).toBe(201);
    const send = (times: unknown) => request(app).post(`${api}/admin/forms/preview/validate`).set(bearer(tok.admin)).send({ fields: [{ key: 'times', label: 'Times', type: 'grid', props: { columns: cols } }], values: { times } });
    const ok = await send([
      { day: '2026-09-21', timeIn: '09:00', timeOut: '17:30', breakHours: 0.5 },
      { timeIn: '08:40', timeOut: '12:00' },
      { timeIn: '22:00', timeOut: '06:00' },
    ]);
    expect(ok.status).toBe(200);
    const stored = JSON.parse(ok.body.stored[0].value);
    expect(stored.rows.map((r: Record<string, string>) => [r.timeIn, r.timeOut, r.hours, r.shift, r.pay])).toEqual([
      ['09:00', '17:30', '8.00', '8.50', '160.00'],
      ['08:40', '12:00', '3.33', '3.33', '66.60'],
      ['22:00', '06:00', '-16.00', '8.00', '-320.00'],
    ]);
    expect(stored.totals).toEqual({ hours: '-4.67', pay: '-93.40' });
    expect((await send([{ timeIn: '9am', timeOut: '17:00' }])).body.error.details[0].message).toBe('Times row 1: Time in must be a time in HH:MM format');
    expect((await send([{ timeIn: '25:00', timeOut: '17:00' }])).status).toBe(400);
    const optional = cols.map((c) => ({ ...c, required: undefined }));
    const half = await request(app).post(`${api}/admin/forms/preview/validate`).set(bearer(tok.admin)).send({ fields: [{ key: 'times', label: 'Times', type: 'grid', props: { columns: optional } }], values: { times: [{ timeIn: '09:00' }] } });
    expect(JSON.parse(half.body.stored[0].value).rows[0]).toMatchObject({ timeIn: '09:00', timeOut: null, hours: null, pay: null }); // not -9 hours
  });

  it('rejects bad rows with a message naming the row and column', async () => {
    const msg = async (items: unknown) => {
      const res = await submit({ items });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].path).toBe('items');
      return res.body.error.details[0].message as string;
    };
    expect(await msg([{ item: 'A', qty: 'lots' }])).toBe('Items row 1: Qty must be a number');
    expect(await msg([{ item: 'A' }, { qty: 2 }])).toBe('Items row 2: Item is required');
    expect(await msg([{ item: 'A', category: 'Other' }])).toContain('row 1: Category');
    expect(await msg([{ item: 'A', surprise: 1 }])).toContain('row 1'); // a key that is not a column
    expect(await msg([{ item: 'A' }, { item: 'B' }, { item: 'C' }, { item: 'D' }])).toBe('Items allows at most 3 rows');
    expect(await msg('A')).toBe('Items must be a list of rows');
    expect(await msg([['A']])).toBe('Items must be a list of rows');
    expect(await msg([])).toContain('Items'); // required
    expect(await msg([{ item: '' }])).toContain('Items');
    expect((await submit({})).status).toBe(400);
  });
});
