import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

// Resubmitting after a send-back on a form with every kind of control.
const api = '/api/v1';
let t: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

const columns = [
  { key: 'item', label: 'Item', type: 'text', required: true },
  { key: 'qty', label: 'Qty', type: 'number', total: true },
  { key: 'price', label: 'Unit price', type: 'currency' },
  { key: 'amount', label: 'Amount', type: 'calc', formula: 'qty * price', total: true },
];
const fields = [
  { key: 'intro', label: 'About', type: 'heading' },
  { key: 'title', label: 'Title', type: 'text', required: true },
  { key: 'when', label: 'When', type: 'date' },
  { key: 'meeting', label: 'Meeting', type: 'datetime' },
  { key: 'size', label: 'Size', type: 'radio', options: ['S', 'M'] },
  { key: 'extras', label: 'Extras', type: 'multiselect', options: ['Hotel', 'Car'] },
  { key: 'ok', label: 'OK', type: 'checkbox' },
  { key: 'items', label: 'Items', type: 'grid', required: true, props: { columns, minRows: 1, maxRows: 3 } },
  { key: 'typed', label: 'Typed signature', type: 'signature' },
  { key: 'sign', label: 'Sign here', type: 'sigpad', required: true },
];
const SIG = { strokes: [[10, 10, 90, 40]] };
const values = {
  title: 'Trip', when: '2026-11-01', meeting: '2026-11-02T14:45', size: 'S', extras: ['Hotel'], ok: true,
  items: [{ item: 'Desk', qty: '2', price: '100' }], typed: 'Sam', sign: SIG,
};
const stepsOf = (requestId: number) =>
  tenantQuery<{ RequestStepId: number; Status: string }>(t.tenantId, 'SELECT RequestStepId, Status FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R ORDER BY StepOrder', { R: requestId });

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ann: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@sbr.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@sbr.test`)).body.accessToken;
  }
  const created = await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Rich', slug: 'rich', fields });
  expect(created.status).toBe(201);
  formId = created.body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Check', approverUserId: ids.ann }] });
});
afterAll(closePool);

describe('resubmit on a form with every control', () => {
  it('works', async () => {
    const sub = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values });
    expect(sub.status).toBe(201);
    const id = sub.body.requestId;
    const [s1] = await stepsOf(id);
    expect((await request(app).post(`${api}/approvals/${s1.RequestStepId}/decision`).set(bearer(tok.ann)).send({ decision: 'return', returnReason: 'Fix qty' })).status).toBe(200);
    const res = await request(app).post(`${api}/my/requests/${id}/resubmit`).set(bearer(tok.sam))
      .send({ values: { ...values, items: [{ item: 'Desk', qty: '3', price: '100' }], extras: ['Hotel', 'Car'] }, note: 'done' });
    if (res.status !== 200) console.log(res.status, JSON.stringify(res.body));
    expect(res.status).toBe(200);
    expect((await stepsOf(id)).map((s) => s.Status)).toEqual(['Active']);
  });
});
