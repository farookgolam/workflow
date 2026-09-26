import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

// an order form: line items in a grid, a delivery charge, then subtotal, tax and total worked out from them
const fields = [
  { key: 'items', label: 'Items', type: 'grid', props: { columns: [
    { key: 'description', label: 'Description', type: 'text' },
    { key: 'qty', label: 'Qty', type: 'number' },
    { key: 'price', label: 'Price', type: 'currency' },
    { key: 'amount', label: 'Amount', type: 'calc', formula: 'qty * price', total: true },
  ] } },
  { key: 'delivery', label: 'Delivery', type: 'currency' },
  { key: 'taxRate', label: 'Tax rate (%)', type: 'number', props: { defaultValue: '8' } },
  { key: 'total', label: 'Total', type: 'currency', rules: { max: 10000 }, props: { formula: 'subtotal + tax' } }, // before what it reads: order does not matter
  { key: 'subtotal', label: 'Subtotal', type: 'currency', props: { formula: 'items.amount + delivery' } },
  { key: 'tax', label: 'Tax', type: 'currency', props: { formula: 'subtotal * taxRate / 100' } },
  { key: 'start', label: 'Start', type: 'time', props: { width: 6 } },
  { key: 'end', label: 'End', type: 'time', props: { width: 6 } },
  { key: 'hours', label: 'Hours', type: 'number', props: { formula: 'elapsed(start, end)', decimals: 1 } },
];
const submit = (values: Record<string, unknown>) => request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values });
const stored = async (requestId: number) =>
  Object.fromEntries((await tenantQuery<{ FieldKey: string; Value: string | null }>(t.tenantId, 'SELECT FieldKey, Value FROM RequestData WHERE TenantId = @TenantId AND RequestId = @R', { R: requestId })).map((r) => [r.FieldKey, r.Value]));

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ann: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@calc.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@calc.test`)).body.accessToken;
  }
  const created = await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Order', slug: 'order', fields });
  expect(created.status).toBe(201);
  formId = created.body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Check', approverUserId: ids.ann }] });
});
afterAll(closePool);

describe('calculated number and currency controls', () => {
  it('works the values out on the server, in whatever order the controls are, ignoring what the browser sent', async () => {
    const res = await submit({
      items: [{ description: 'Paper', qty: 10, price: 4.5 }, { description: 'Toner', qty: 2, price: 60 }],
      delivery: 15,
      taxRate: 8,
      start: '22:00',
      end: '06:30',
      total: 1, // a made-up total is ignored
    });
    expect(res.status).toBe(201);
    const v = await stored(res.body.requestId);
    // items 45 + 120 = 165, + delivery 15 = 180; tax 8% = 14.40; total 194.40
    expect(v).toMatchObject({ subtotal: '180.00', tax: '14.40', total: '194.40', hours: '8.5' });
  });

  it('leaves a result empty when nothing it reads is filled in, and counts a blank as 0 otherwise', async () => {
    const empty = await stored((await submit({})).body.requestId);
    expect(empty).toMatchObject({ subtotal: null, tax: null, total: null, hours: null });

    const deliveryOnly = await stored((await submit({ delivery: 20 })).body.requestId);
    expect(deliveryOnly).toMatchObject({ subtotal: '20.00', total: '20.00' }); // no tax rate: tax reads as 0
    const oneTime = await stored((await submit({ start: '09:00' })).body.requestId);
    expect(oneTime.hours).toBeNull(); // a missing time is not midnight
  });

  it('applies the minimum and maximum to the result', async () => {
    const res = await submit({ items: [{ description: 'Server', qty: 1, price: 9500 }], taxRate: 8 });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([{ path: 'total', message: 'Total must be at most 10000' }]);
  });

  it('refuses formulas that cannot work when the form is saved', async () => {
    const make = (extra: Record<string, unknown>[]) => request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({
      name: 'Bad', slug: `bad-${Math.random().toString(36).slice(2)}`, fields: [{ key: 'a', label: 'A', type: 'number' }, ...extra],
    });
    const message = async (extra: Record<string, unknown>[]) => { const r = await make(extra); expect(r.status).toBe(400); return JSON.stringify(r.body.error); };

    expect(await message([{ key: 'b', label: 'B', type: 'number', props: { formula: 'a * nope' } }])).toContain('uses \\"nope\\"');
    expect(await message([{ key: 'b', label: 'B', type: 'number', props: { formula: 'a +' } }])).toContain('is incomplete');
    expect(await message([{ key: 'b', label: 'B', type: 'number', props: { formula: 'c + 1' } }, { key: 'c', label: 'C', type: 'number', props: { formula: 'b + 1' } }])).toContain('circle');
    expect(await message([{ key: 'b', label: 'B', type: 'number', props: { formula: 'b + a' } }])).toContain('uses itself');
    expect(await message([{ key: 'b', label: 'B', type: 'date', props: { formula: 'a' } }])).toContain('only a number, currency or text');
    expect(await message([{ key: 'b', label: 'B', type: 'number', props: { formula: 'a.x' } }])).toContain('data grid');
    expect((await make([{ key: 'b', label: 'B', type: 'number', props: { formula: 'round(a / 3, 1)', decimals: 1 } }])).status).toBe(201);
  });
});
