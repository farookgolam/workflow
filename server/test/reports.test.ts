import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser, recordStepAnswers } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

const fields = [
  { key: 'dept', label: 'Department', type: 'select', options: ['Finance', 'Sales', 'IT'] },
  { key: 'amount', label: 'Amount', type: 'currency' },
  { key: 'neededBy', label: 'Needed by', type: 'date' },
  { key: 'urgent', label: 'Urgent', type: 'checkbox' },
  { key: 'items', label: 'Items', type: 'grid', props: { columns: [
    { key: 'description', label: 'Description', type: 'text' },
    { key: 'qty', label: 'Qty', type: 'number' },
    { key: 'price', label: 'Price', type: 'currency' },
    { key: 'lineTotal', label: 'Line total', type: 'calc', formula: 'qty * price', total: true },
  ] } },
];
const run = (definition: Record<string, unknown>, as = 'admin') => request(app).post(`${api}/admin/reports/run`).set(bearer(tok[as])).send({ definition: { formId, ...definition } });

async function submitAndDecide(values: Record<string, unknown>, outcome: 'approve' | 'reject' | null, costCode?: string) {
  const res = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values });
  expect(res.status).toBe(201);
  if (outcome) {
    const [step] = await tenantQuery<{ RequestStepId: number }>(t.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R', { R: res.body.requestId });
    const d = await request(app).post(`${api}/approvals/${step.RequestStepId}/decision`).set(bearer(tok.ann))
      .send(outcome === 'approve' ? { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] } } : { decision: 'reject', rejectionReason: 'No budget' });
    expect(d.status).toBe(200);
    // approvers no longer fill in controls: report on what one entered under an older chain
    if (costCode) await recordStepAnswers(t.tenantId, step.RequestStepId, [{ key: 'costCode', label: 'Cost code', type: 'text', value: costCode }]);
  }
  return res.body.requestNumber as string;
}

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ann: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@rep.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@rep.test`)).body.accessToken;
  }
  formId = (await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Purchase', slug: 'purchase', fields })).body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Finance', approverUserId: ids.ann }] });

  await submitAndDecide({ dept: 'Finance', amount: 120, neededBy: '2026-10-05', urgent: true, items: [{ description: 'Paper', qty: 10, price: 4.5 }, { description: '=HYPERLINK("x")', qty: 1, price: 75 }] }, 'approve', 'FIN-1');
  await submitAndDecide({ dept: 'Sales', amount: 80, neededBy: '2026-11-20', items: [{ description: 'Paper', qty: 4, price: 4.5 }] }, 'reject', 'SAL-9');
  await submitAndDecide({ dept: 'finance', amount: 310.5 }, null).catch(() => undefined); // not an option: refused
  await submitAndDecide({ dept: 'Finance', amount: 310.5, neededBy: '2026-11-02' }, null);
});
afterAll(closePool);

describe('the catalog of what a report can show', () => {
  it('lists the request, the form controls, grid totals, each approver section, and the grids for line reports', async () => {
    const c = (await request(app).get(`${api}/admin/reports/catalog?formId=${formId}`).set(bearer(tok.admin))).body;
    const refs = c.columns.map((x: { ref: string }) => x.ref);
    expect(refs).toEqual(expect.arrayContaining(['req.number', 'req.status', 'req.days', 'f.dept', 'f.amount', 'f.neededBy', 'f.urgent', 'gt.items.qty', 'gt.items.lineTotal', 's1.costCode']));
    expect(refs).not.toContain('gt.items.description'); // only number columns have totals
    expect(c.columns.find((x: { ref: string }) => x.ref === 's1.costCode')).toMatchObject({ label: 'Cost code', group: 'Step 1: Finance' });
    expect(c.grids).toEqual([expect.objectContaining({ key: 'items', label: 'Items' })]);
    expect(c.grids[0].columns.map((x: { ref: string; type: string }) => `${x.ref}:${x.type}`)).toEqual(['g.description:text', 'g.qty:number', 'g.price:number', 'g.lineTotal:number']);
  });
});

describe('running reports', () => {
  it('one row per request with the chosen columns, newest first, and totals for number columns', async () => {
    const r = (await run({ columns: [{ ref: 'req.status' }, { ref: 'f.dept' }, { ref: 'f.amount' }, { ref: 'f.urgent' }, { ref: 'gt.items.lineTotal' }, { ref: 's1.costCode' }] })).body;
    expect(r.columns.map((c: { label: string }) => c.label)).toEqual(['Status', 'Department', 'Amount', 'Urgent', 'Items: Line total (total)', 'Cost code']);
    expect(r.rows).toEqual([
      ['InProgress', 'Finance', 310.5, 'No', null, null],
      ['Rejected', 'Sales', 80, 'No', 18, 'SAL-9'],
      ['Approved', 'Finance', 120, 'Yes', 120, 'FIN-1'],
    ]);
    expect(r.totals).toEqual([null, null, 510.5, null, 138, null]);
    expect(r).toMatchObject({ records: 3, truncated: false });
  });

  it('filters by value, by status and by date, and sorts', async () => {
    const byAmount = (await run({ columns: [{ ref: 'f.amount' }], filters: [{ ref: 'f.amount', op: 'gt', value: '100' }], sort: { ref: 'f.amount', dir: 'asc' } })).body;
    expect(byAmount.rows).toEqual([[120], [310.5]]);
    const text = (await run({ columns: [{ ref: 'f.dept' }], filters: [{ ref: 'f.dept', op: 'eq', value: 'finance' }] })).body; // ignoring capitals
    expect(text.records).toBe(2);
    const dates = (await run({ columns: [{ ref: 'f.neededBy' }], filters: [{ ref: 'f.neededBy', op: 'between', value: '2026-11-01', value2: '2026-11-30' }], sort: { ref: 'f.neededBy', dir: 'asc' } })).body;
    expect(dates.rows).toEqual([['2026-11-02'], ['2026-11-20']]);
    const closed = (await run({ columns: [{ ref: 'req.number' }], statuses: ['Approved', 'Rejected'] })).body;
    expect(closed.records).toBe(2);
    const empty = (await run({ columns: [{ ref: 'req.number' }], filters: [{ ref: 's1.costCode', op: 'empty' }] })).body;
    expect(empty.records).toBe(1);
    const tooLate = (await run({ columns: [{ ref: 'req.number' }], submittedTo: '2000-01-01' })).body;
    expect(tooLate.records).toBe(0);
  });

  it('groups and summarises: per department, and per month', async () => {
    const byDept = (await run({ columns: [{ ref: 'f.dept' }, { ref: 'f.amount' }, { ref: 'f.amount', agg: 'avg' }, { ref: 's1.costCode' }], groupBy: 'f.dept' })).body;
    expect(byDept.columns.map((c: { label: string }) => c.label)).toEqual(['Department', 'Requests', 'Total of Amount', 'Average of Amount', 'Count of Cost code']);
    expect(byDept.rows).toEqual([['Finance', 2, 430.5, 215.25, 1], ['Sales', 1, 80, 80, 1]]);
    expect(byDept.totals).toEqual(['Total', 3, 510.5, 170.166667, 2]);

    const byMonth = (await run({ columns: [{ ref: 'f.amount', agg: 'max' }], groupBy: 'f.neededBy', groupPeriod: 'month' })).body;
    expect(byMonth.columns[0].label).toBe('Needed by (month)');
    expect(byMonth.rows).toEqual([['10/2026', 1, 120], ['11/2026', 2, 310.5]]);
    const byDay = (await run({ columns: [{ ref: 'f.amount' }], groupBy: 'f.neededBy', groupPeriod: 'day' })).body;
    expect(byDay.rows.map((r: unknown[]) => r[0])).toEqual(['10/05/2026', '11/02/2026', '11/20/2026']); // in date order, written MM/DD/YYYY
    const byWeek = (await run({ columns: [{ ref: 'f.amount' }], groupBy: 'f.neededBy', groupPeriod: 'week' })).body;
    expect(byWeek.rows[0][0]).toBe('Week 41, 2026');
  });

  it('one row per line of a data grid, and grouped by a grid column', async () => {
    const lines = (await run({ lineItems: 'items', columns: [{ ref: 'req.status' }, { ref: 'g.description' }, { ref: 'g.qty' }, { ref: 'g.lineTotal' }], sort: { ref: 'g.lineTotal', dir: 'desc' } })).body;
    expect(lines.rows).toEqual([['Approved', '=HYPERLINK("x")', 1, 75], ['Approved', 'Paper', 10, 45], ['Rejected', 'Paper', 4, 18]]);
    expect(lines.totals).toEqual([null, null, 15, 138]);

    const perItem = (await run({ lineItems: 'items', columns: [{ ref: 'g.qty' }, { ref: 'g.lineTotal' }], groupBy: 'g.description' })).body;
    expect(perItem.columns[1].label).toBe('Lines');
    expect(perItem.rows).toEqual([['=HYPERLINK("x")', 1, 1, 75], ['Paper', 2, 14, 63]]);
  });

  it('refuses what does not fit the form', async () => {
    expect((await run({ columns: [{ ref: 'f.nope' }] })).body.error.code).toBe('unknown_column');
    expect((await run({ columns: [{ ref: 'g.qty' }] })).body.error.message).toContain('one row per line');
    expect((await run({ columns: [{ ref: 'f.amount' }], filters: [{ ref: 'f.amount', op: 'gt', value: 'lots' }] })).body.error.code).toBe('filter_value');
    expect((await run({ columns: [{ ref: 'f.amount' }], filters: [{ ref: 'f.amount', op: 'gt' }] })).body.error.code).toBe('filter_value');
    expect((await run({ columns: [] })).status).toBe(400);
    expect((await run({ columns: [{ ref: 'DROP TABLE' }] })).status).toBe(400);
  });
});

describe('exports', () => {
  it('CSV: UTF-8 for Excel, formulas neutralised, totals row, and recorded in the audit log', async () => {
    const res = await request(app).post(`${api}/admin/reports/export`).set(bearer(tok.admin))
      .send({ format: 'csv', name: 'Line items', definition: { formId, lineItems: 'items', columns: [{ ref: 'g.description' }, { ref: 'g.lineTotal' }] } });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="Line_items_\d{8}\.csv"/);
    expect(res.text.charCodeAt(0)).toBe(0xfeff);
    const lines = res.text.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('Description,Line total');
    expect(lines).toContain(`"'=HYPERLINK(""x"")",75`); // a spreadsheet shows it, never runs it
    expect(lines.at(-1)).toBe(',138');
    const [logged] = await tenantQuery<{ DetailJson: string }>(t.tenantId, `SELECT TOP 1 DetailJson FROM AuditLog WHERE TenantId = @TenantId AND Action = 'report.exported' ORDER BY AuditId DESC`);
    expect(JSON.parse(logged.DetailJson)).toMatchObject({ name: 'Line items', format: 'csv', rows: 3 });
  });

  it('Excel: a real workbook', async () => {
    const res = await request(app).post(`${api}/admin/reports/export`).set(bearer(tok.admin)).buffer(true).parse((r, cb) => { const chunks: Buffer[] = []; r.on('data', (c: Buffer) => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); })
      .send({ format: 'xlsx', definition: { formId, columns: [{ ref: 'req.number' }, { ref: 'req.submittedAt' }, { ref: 'f.amount' }] } });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe('PK'); // a zip, as every .xlsx is
  });

  it('dates come out as MM/DD/YYYY, and times in the time zone of the reader', async () => {
    const definition = { formId, columns: [{ ref: 'f.neededBy' }, { ref: 'req.submittedAt' }], filters: [{ ref: 'f.neededBy', op: 'eq', value: '2026-10-05' }] };
    const csv = await request(app).post(`${api}/admin/reports/export`).set(bearer(tok.admin)).send({ format: 'csv', definition, timeZone: 'America/New_York' });
    const [, row] = csv.text.slice(1).trim().split('\r\n');
    expect(row).toMatch(/^10\/05\/2026,\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2} (AM|PM)$/);
    // the same instant, written in New York and in UTC, differs by the offset
    const [{ SubmittedAt }] = await tenantQuery<{ SubmittedAt: Date }>(t.tenantId, `SELECT TOP 1 r.SubmittedAt FROM Requests r JOIN RequestData d ON d.TenantId = r.TenantId AND d.RequestId = r.RequestId AND d.FieldKey = 'neededBy' AND d.Value = '2026-10-05' WHERE r.TenantId = @TenantId`);
    const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(SubmittedAt).replace(',', '');
    expect(row.split(',')[1]).toBe(ny);
    const utc = await request(app).post(`${api}/admin/reports/export`).set(bearer(tok.admin)).send({ format: 'csv', definition, timeZone: 'Not/AZone' });
    expect(utc.status).toBe(200); // an unknown zone falls back to UTC rather than failing
  });
});

describe('saved reports and who may see them', () => {
  it('saves, lists, reopens, renames and deletes; names are unique', async () => {
    const definition = { formId, columns: [{ ref: 'f.dept' }, { ref: 'f.amount' }], groupBy: 'f.dept' };
    const saved = await request(app).post(`${api}/admin/reports/saved`).set(bearer(tok.admin)).send({ name: 'Spend by department', definition });
    expect(saved.status).toBe(201);
    expect((await request(app).post(`${api}/admin/reports/saved`).set(bearer(tok.admin)).send({ name: 'Spend by department', definition })).status).toBe(409);

    const list = (await request(app).get(`${api}/admin/reports/saved`).set(bearer(tok.admin))).body.reports;
    expect(list).toEqual([expect.objectContaining({ name: 'Spend by department', formName: 'Purchase', updatedBy: 'ADMIN' })]);
    const opened = (await request(app).get(`${api}/admin/reports/saved/${saved.body.reportId}`).set(bearer(tok.admin))).body;
    expect(opened.definition).toMatchObject(definition);

    expect((await request(app).put(`${api}/admin/reports/saved/${saved.body.reportId}`).set(bearer(tok.admin)).send({ name: 'Spend per dept', definition })).status).toBe(204);
    expect((await request(app).delete(`${api}/admin/reports/saved/${saved.body.reportId}`).set(bearer(tok.admin))).status).toBe(204);
    expect((await request(app).get(`${api}/admin/reports/saved`).set(bearer(tok.admin))).body.reports).toEqual([]);
  });

  it('administrators only, and only their own organisation', async () => {
    expect((await run({ columns: [{ ref: 'f.amount' }] }, 'sam')).status).toBe(403);
    const other = await makeTenant();
    await makeUser(other.tenantId, 'root@other.test', ['Admin']);
    const otherAdmin = (await login(other.slug, 'root@other.test')).body.accessToken;
    expect((await request(app).get(`${api}/admin/reports/catalog?formId=${formId}`).set(bearer(otherAdmin))).status).toBe(404);
    expect((await request(app).post(`${api}/admin/reports/run`).set(bearer(otherAdmin)).send({ definition: { formId, columns: [{ ref: 'f.amount' }] } })).status).toBe(404);
  });
});
