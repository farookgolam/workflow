import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { elapsedHours, guessMapping } from '../src/reports/hours';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let other: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

// named like the tenant-1 form: the column keys say nothing, the headings do
const fields = [
  { key: 'week', label: 'Week of', type: 'date' },
  { key: 'employeeId', label: 'Employee ID', type: 'text' },
  { key: 'intro', label: 'Fill in every day you worked', type: 'heading' },
  { key: 'dataGrid', label: 'Timesheet', type: 'grid', props: { minRows: 1, columns: [
    { key: 'date', label: 'Date', type: 'date', required: true },
    { key: 'school', label: 'School', type: 'text' },
    { key: 'timing', label: 'Time In', type: 'time' },
    { key: 'timeout', label: 'Time Out', type: 'time' },
    { key: 'wh', label: 'Worked Hour', type: 'calc', formula: 'timeout - timing' },
  ] } },
];
const hours = (body: Record<string, unknown>, as = 'admin') => request(app).post(`${api}/admin/reports/hours/run`).set(bearer(tok[as])).send({ formId, ...body });

async function timesheet(who: 'sam' | 'kim', rows: Record<string, string>[], approve: boolean) {
  const res = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok[who])).send({ values: { dataGrid: rows, employeeId: who === 'sam' ? 'E-100' : 'E-200' } });
  expect(res.status).toBe(201);
  if (approve) {
    const [step] = await tenantQuery<{ RequestStepId: number }>(t.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R', { R: res.body.requestId });
    expect((await request(app).post(`${api}/approvals/${step.RequestStepId}/decision`).set(bearer(tok.ann)).send({ decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] } })).status).toBe(200);
  }
}

beforeAll(async () => {
  t = await makeTenant();
  other = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], kim: ['Submitter'], ann: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@hrs.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@hrs.test`)).body.accessToken;
  }
  await makeUser(other.tenantId, 'boss@hrs.test', ['Admin'], 'BOSS');
  tok.otherAdmin = (await login(other.slug, 'boss@hrs.test')).body.accessToken;

  formId = (await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Timesheet', slug: 'timesheet', fields })).body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Secretary', approverUserId: ids.ann }] });

  await timesheet('sam', [
    { date: '2026-09-01', school: 'Hawes', timing: '08:00', timeout: '12:30' },
    { date: '2026-09-02', school: 'Orchard', timing: '13:00', timeout: '17:15' },
    { date: '2026-09-10', school: 'Hawes', timing: '08:00', timeout: '09:00' }, // outside the range below
  ], true);
  await timesheet('kim', [{ date: '2026-09-02', school: 'Ridge', timing: '22:00', timeout: '06:00' }], true); // past midnight: stored as -16
  await timesheet('kim', [{ date: '2026-09-01', school: 'Ridge', timing: '09:00', timeout: '10:00' }], false); // still in progress
});
afterAll(closePool);

describe('Hours report', () => {
  it('finds timesheet forms and guesses which column is which from the headings', async () => {
    const res = await request(app).get(`${api}/admin/reports/hours/forms`).set(bearer(tok.admin));
    expect(res.body.forms).toEqual([expect.objectContaining({ formId, grid: 'dataGrid', mapping: { date: 'date', school: 'school', timeIn: 'timing', timeOut: 'timeout', worked: 'wh' } })]);
    expect((await request(app).get(`${api}/admin/reports/hours/forms`).set(bearer(tok.otherAdmin))).body.forms).toEqual([]);
    expect(guessMapping([{ key: 'd', label: 'Day', type: 'date' }, { key: 'a', label: 'Start', type: 'time' }, { key: 'b', label: 'Finish', type: 'time' }])).toMatchObject({ timeIn: 'a', timeOut: 'b', worked: null });
    expect(elapsedHours('22:00', '06:00')).toBe(8);
    expect(elapsedHours('08:00', '12:30')).toBe(4.5);
  });

  it('everyone over a range of days worked: grouped by person, subtotals, total; approved only', async () => {
    const res = await hours({ from: '2026-09-01', to: '2026-09-05' });
    expect(res.status).toBe(200);
    const kinds = res.body.lines.map((l: { kind: string; submitter: string; hours: number }) => `${l.kind}:${l.submitter}:${l.hours}`);
    expect(kinds).toEqual(['line:KIM:8', 'subtotal:KIM:8', 'line:SAM:4.5', 'line:SAM:4.25', 'subtotal:SAM:8.75', 'total::16.75']);
    expect(res.body).toMatchObject({ totalHours: 16.75, lineCount: 3, people: 2, submitter: null });
    expect(res.body.lines[2]).toMatchObject({ date: '2026-09-01', school: 'Hawes', timeIn: '08:00', timeOut: '12:30' });
  });

  it('one submitter, one day, and in-progress timesheets only when asked', async () => {
    const one = await hours({ from: '2026-09-01', submitterUserId: ids.kim });
    expect(one.body).toMatchObject({ submitter: 'KIM', lineCount: 0, totalHours: 0 });
    const withOpen = await hours({ from: '2026-09-01', submitterUserId: ids.kim, includeInProgress: true });
    expect(withOpen.body.lines.map((l: { kind: string }) => l.kind)).toEqual(['line', 'total']);
    expect(withOpen.body.totalHours).toBe(1);
  });

  it('checks its input and stays inside the organisation', async () => {
    expect((await hours({ from: '2026-09-05', to: '2026-09-01' })).status).toBe(400);
    expect((await hours({ from: '2026-09-01', mapping: { date: 'school' } })).status).toBe(400);
    expect((await hours({ from: '2026-09-01' }, 'sam')).status).toBe(403);
    expect((await hours({ from: '2026-09-01' }, 'otherAdmin')).status).toBe(404);
  });

  it('adds chosen fields of the form as extra columns, on every line and in the export', async () => {
    const forms = await request(app).get(`${api}/admin/reports/hours/forms`).set(bearer(tok.admin));
    // the form's own answerable fields are offered; the grid and layout elements are not
    expect(forms.body.forms[0].fields.map((f: { key: string }) => f.key)).toEqual(['week', 'employeeId']);

    const res = await hours({ from: '2026-09-01', to: '2026-09-05', fields: ['employeeId'] });
    expect(res.status).toBe(200);
    expect(res.body.extraColumns).toEqual([{ key: 'employeeId', label: 'Employee ID' }]);
    expect(res.body.lines.map((l: { kind: string; extra: (string | null)[] }) => `${l.kind}:${l.extra.join('|')}`))
      .toEqual(['line:E-200', 'subtotal:', 'line:E-100', 'line:E-100', 'subtotal:', 'total:']);

    const csv = await request(app).post(`${api}/admin/reports/hours/export`).set(bearer(tok.admin)).send({ query: { formId, from: '2026-09-01', to: '2026-09-05', fields: ['employeeId'] }, format: 'csv' });
    expect(csv.text).toContain('Submitter,Employee ID,Date,School,Time In,Time Out,Worked Hour,Request');
    expect(csv.text).toContain('SAM,E-100,09/01/2026,Hawes,08:00,12:30,4.5,');
    expect(csv.text).toContain('Subtotal - SAM,,2 day(s),,,,8.75,');

    expect((await hours({ from: '2026-09-01', fields: ['dataGrid'] })).status).toBe(400); // not an extra-column field
    expect((await hours({ from: '2026-09-01', fields: ['nope'] })).status).toBe(400);
  });

  it('exports to Excel and CSV, and records the export', async () => {
    const csv = await request(app).post(`${api}/admin/reports/hours/export`).set(bearer(tok.admin)).send({ query: { formId, from: '2026-09-01', to: '2026-09-05' }, format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain('Submitter,Date,School,Time In,Time Out,Worked Hour,Request');
    expect(csv.text).toContain('Subtotal - SAM,2 day(s),,,,8.75,');
    expect(csv.text).toContain('SAM,09/01/2026,Hawes,08:00,12:30,4.5,');
    expect(csv.headers['content-disposition']).toMatch(/filename="Hours_-_All_submitters_-_09_01_2026_to_09_05_2026\.csv"/);
    const xlsx = await request(app).post(`${api}/admin/reports/hours/export`).set(bearer(tok.admin)).send({ query: { formId, from: '2026-09-01' }, format: 'xlsx' }).buffer(true);
    expect(xlsx.status).toBe(200);
    const [a] = await tenantQuery<{ n: number }>(t.tenantId, "SELECT COUNT(*) AS n FROM AuditLog WHERE TenantId = @TenantId AND Action = 'report.exported'");
    expect(a.n).toBe(3);
  });
});
