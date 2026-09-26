// Each step says how its approver is found: always the same person, or chosen by the person before it - the submitter
// for step 1, the approver of step N-1 for step N - from that step's own lookup file (or from every approver).
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let formId: number;
const lists: Record<string, number> = {};
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('List');
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const importList = async (name: string, key: string, rows: unknown[][]) =>
  (await request(app).post(`${api}/admin/lookups/import?name=${encodeURIComponent(name)}&keyColumn=${encodeURIComponent(key)}`).set(bearer(tok.admin)).set('Content-Type', 'application/octet-stream').send(await xlsx(rows))).body.lookupId as number;

// every approval step picks from a different file
const SECRETARIES = [['School', 'Secretary', 'Email'], ['Hawes', 'Sue Sec', 'sue@ac.test'], ['Ridge', 'New Person', 'new.sec@ac.test'], ['Valley', 'Sam Sub', 'sam@ac.test'], ['Blank', 'Nobody', '']];
const PRINCIPALS = [['School', 'Principal', 'Email', 'Phone'], ['Hawes', 'Pia Principal', 'pia@ac.test', '555-1'], ['Ridge', 'Sue Sec', 'sue@ac.test', '555-2'], ['Gone', 'Dee Activated', 'dee@ac.test', '555-3']];
const PAY = [['Manager', 'Email'], ['Pay Clerk', 'pay@ac.test']];

const chosen = (list: string, nameColumn: string | null, columns: string[] = []) => ({ lookupId: lists[list], emailColumn: 'Email', nameColumn, columns });
const chain = () => ({
  steps: [
    { name: 'Secretary', chosen: chosen('secretaries', 'Secretary') },
    { name: 'Principal', chosen: chosen('principals', 'Principal', ['Phone']) },
    { name: 'Payroll', chosen: chosen('pay', null) },
  ],
});
const publish = (body: unknown) => request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send(body);
const submit = (extra: Record<string, unknown> = {}) => request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { title: 'Trip' }, ...extra });
const stepsOf = (requestId: number) =>
  tenantQuery<{ RequestStepId: number; Status: string; AssignedUserId: number }>(t.tenantId, 'SELECT RequestStepId, Status, AssignedUserId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R ORDER BY StepOrder', { R: requestId });
const userByEmail = async (email: string) =>
  (await tenantQuery<{ UserId: number; Roles: string; HasKey: number }>(t.tenantId, `SELECT u.UserId, (SELECT STRING_AGG(r.Role, ',') FROM UserRoles r WHERE r.TenantId = u.TenantId AND r.UserId = u.UserId) AS Roles, CASE WHEN u.PasswordSetAt IS NULL THEN 0 ELSE 1 END AS HasKey FROM Users u WHERE u.TenantId = @TenantId AND u.Email = @E`, { E: email }))[0];
const decide = (as: string, requestStepId: number, body: Record<string, unknown>) =>
  request(app).post(`${api}/approvals/${requestStepId}/decision`).set(bearer(tok[as])).send(body);

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], sue: ['Approver'], pia: ['Submitter'], dee: ['Approver'], pay: ['Approver'], fixed: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@ac.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@ac.test`)).body.accessToken;
  }
  await tenantQuery(t.tenantId, 'UPDATE Users SET IsActive = 0 WHERE TenantId = @TenantId AND UserId = @U', { U: ids.dee });
  lists.secretaries = await importList('Secretaries', 'School', SECRETARIES);
  lists.principals = await importList('Principals', 'School', PRINCIPALS);
  lists.pay = await importList('Pay', 'Manager', PAY);
  formId = (await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Leave', slug: 'leave', fields: [{ key: 'title', label: 'Title', type: 'text' }] })).body.formId;
  const res = await publish(chain());
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
});
afterAll(closePool);

describe('setting up who approves each step', () => {
  it('keeps each step\'s setting, and shows it back to the chain editor', async () => {
    const editor = (await request(app).get(`${api}/admin/forms/${formId}`).set(bearer(tok.admin))).body;
    expect(editor.steps.map((s: { name: string; approverUserId: number | null; chosen: unknown }) => [s.name, s.approverUserId, s.chosen])).toEqual([
      ['Secretary', null, { lookupId: lists.secretaries, emailColumn: 'Email', nameColumn: 'Secretary', columns: [] }],
      ['Principal', null, { lookupId: lists.principals, emailColumn: 'Email', nameColumn: 'Principal', columns: ['Phone'] }],
      ['Payroll', null, { lookupId: lists.pay, emailColumn: 'Email', nameColumn: null, columns: [] }],
    ]);
  });

  it('refuses a step with nobody to go to, with both settings, or pointing at a file or column that does not exist', async () => {
    const step = (over: Record<string, unknown>) => publish({ steps: [{ name: 'X', ...over }] });
    expect(JSON.stringify((await step({})).body)).toContain('choose who approves it');
    expect(JSON.stringify((await step({ approverUserId: ids.fixed, chosen: chosen('pay', null) })).body)).toContain('not both');
    expect((await step({ chosen: { lookupId: 999999, emailColumn: 'Email' } })).status).toBe(400);
    expect(JSON.stringify((await step({ chosen: { lookupId: lists.pay, emailColumn: 'Fax' } })).body)).toContain('email address');
    expect((await step({ chosen: { lookupId: lists.pay, emailColumn: 'Email', columns: ['Salary'] } })).body.error.details[0].message).toContain('no column "Salary"');
    expect((await step({ approverUserId: ids.sam })).body.error.code).toBe('not_an_approver');
    // the chain above is still the current one
    expect((await request(app).get(`${api}/admin/forms/${formId}`).set(bearer(tok.admin))).body.steps).toHaveLength(3);
  });
});

describe('the submitter chooses step 1, each approver chooses the next', () => {
  it('shows the submitter the step 1 list: everyone with a usable email, except themselves', async () => {
    const page = (await request(app).get(`${api}/forms/${formId}`).set(bearer(tok.sam))).body;
    expect(page.firstStep).toMatchObject({ stepOrder: 1, name: 'Secretary', mode: 'chosen', approver: null, list: { name: 'Secretaries', keyColumn: 'School', nameColumn: 'Secretary' } });
    expect(page.firstStep.candidates.map((c: { listKey: string; displayName: string; userId: number | null }) => [c.listKey, c.displayName, c.userId])).toEqual([
      ['Hawes', 'Sue Sec', ids.sue],
      ['Ridge', 'New Person', null], // no account yet - one is made when chosen
    ]);
  });

  it('insists on a choice from the step\'s own list', async () => {
    const none = await submit();
    expect(none.status).toBe(400);
    expect(none.body.error.details).toEqual([{ path: 'firstApprover', message: 'Choose who approves "Secretary"' }]);
    expect((await submit({ firstApproverKey: 'Nowhere' })).body.error.details[0].message).toContain('not in the list');
    expect((await submit({ firstApproverKey: 'Valley' })).body.error.details[0].message).toContain('yourself'); // the submitter's own row
    expect((await submit({ firstApproverUserId: ids.sue })).body.error.details[0].message).toContain('from the "Secretaries" list');
  });

  it('routes the whole chain: submitter -> secretary -> principal -> payroll, each from their own file', async () => {
    const created = await submit({ firstApproverKey: 'Hawes' });
    expect(created.status).toBe(201);
    let steps = await stepsOf(created.body.requestId);
    expect(steps.map((s) => [s.Status, s.AssignedUserId])).toEqual([['Active', ids.sue], ['Waiting', expect.any(Number)], ['Waiting', expect.any(Number)]]);

    // the secretary sees the Principals list, and must pick from it to approve
    const page = (await request(app).get(`${api}/approvals/${steps[0].RequestStepId}`).set(bearer(tok.sue))).body;
    expect(page.step.nextStep).toMatchObject({ name: 'Principal', mode: 'chosen', list: { name: 'Principals', columns: ['Phone'] } });
    expect(page.step.nextStep.candidates.map((c: { listKey: string; info: Record<string, string> }) => [c.listKey, c.info])).toEqual([['Hawes', { Phone: '555-1' }]]); // not herself, not a deactivated person
    const noChoice = await decide('sue', steps[0].RequestStepId, { decision: 'approve' });
    expect(noChoice.body.error.details).toEqual([{ path: 'nextApprover', message: 'Choose who approves "Principal"' }]);
    expect((await decide('sue', steps[0].RequestStepId, { decision: 'approve', nextApproverKey: 'Ridge' })).body.error.details[0].message).toContain('yourself');
    expect((await decide('sue', steps[0].RequestStepId, { decision: 'approve', nextApproverKey: 'Gone' })).body.error.details[0].message).toContain('deactivated');
    expect((await decide('sue', steps[0].RequestStepId, { decision: 'approve', nextApproverKey: 'Hawes' })).body).toEqual({ requestStatus: 'InProgress', nextStepOrder: 2 });

    // the principal had no Approver role: being in the Principals file gives it to her
    expect((await userByEmail('pia@ac.test')).Roles.split(',').sort()).toEqual(['Approver', 'Submitter']);
    tok.pia = (await login(t.slug, 'pia@ac.test')).body.accessToken;
    steps = await stepsOf(created.body.requestId);
    expect(steps[1]).toMatchObject({ Status: 'Active', AssignedUserId: ids.pia });
    expect((await decide('pia', steps[1].RequestStepId, { decision: 'approve', nextApproverKey: 'Pay Clerk' })).body.nextStepOrder).toBe(3);

    // the last step has nobody after it to choose
    steps = await stepsOf(created.body.requestId);
    expect(steps[2]).toMatchObject({ Status: 'Active', AssignedUserId: ids.pay });
    const lastPage = (await request(app).get(`${api}/approvals/${steps[2].RequestStepId}`).set(bearer(tok.pay))).body;
    expect(lastPage.step.nextStep).toBeNull();
    expect((await decide('pay', steps[2].RequestStepId, { decision: 'approve' })).body.requestStatus).toBe('Approved');

    const chosenAudit = await tenantQuery<{ DetailJson: string }>(t.tenantId, `SELECT DetailJson FROM AuditLog WHERE TenantId = @TenantId AND RequestId = @R AND Action = 'step.approver_chosen' ORDER BY AuditId`, { R: created.body.requestId });
    expect(chosenAudit.map((a) => JSON.parse(a.DetailJson)).map((d) => [d.stepOrder, d.fromList.lookup, d.fromList.key])).toEqual([[1, 'Secretaries', 'Hawes'], [2, 'Principals', 'Hawes'], [3, 'Pay', 'Pay Clerk']]);
  });

  it('creates an account for someone in the file who has none, and emails them the link', async () => {
    const created = await submit({ firstApproverKey: 'Ridge' });
    expect(created.status).toBe(201);
    const newcomer = await userByEmail('new.sec@ac.test');
    expect(newcomer).toMatchObject({ Roles: 'Approver', HasKey: 0 });
    expect((await stepsOf(created.body.requestId))[0].AssignedUserId).toBe(newcomer.UserId);
    const [mail] = await tenantQuery<{ RecipientEmail: string }>(t.tenantId, `SELECT RecipientEmail FROM Notifications WHERE TenantId = @TenantId AND RequestId = @R AND Type = 'ApprovalRequested'`, { R: created.body.requestId });
    expect(mail.RecipientEmail).toBe('new.sec@ac.test');
  });

  it('asks for no choice when rejecting', async () => {
    const created = await submit({ firstApproverKey: 'Hawes' });
    const [first] = await stepsOf(created.body.requestId);
    expect((await decide('sue', first.RequestStepId, { decision: 'reject', rejectionReason: 'No' })).body.requestStatus).toBe('Rejected');
  });
});

describe('fixed steps, and steps chosen from every approver', () => {
  it('a fixed step shows its approver and cannot be redirected; a chosen-from-everyone step lists the approvers', async () => {
    const res = await publish({ steps: [{ name: 'Office', approverUserId: ids.fixed }, { name: 'Anyone', chosen: { lookupId: null, emailColumn: null } }] });
    expect(res.status).toBe(200);
    const page = (await request(app).get(`${api}/forms/${formId}`).set(bearer(tok.sam))).body;
    expect(page.firstStep).toMatchObject({ mode: 'fixed', approver: { userId: ids.fixed }, candidates: [] });

    expect((await submit({ firstApproverUserId: ids.sue })).body.error.details[0].message).toContain('fixed');
    const created = await submit();
    expect(created.status).toBe(201);
    const [first] = await stepsOf(created.body.requestId);
    expect(first.AssignedUserId).toBe(ids.fixed);

    const next = (await request(app).get(`${api}/approvals/${first.RequestStepId}`).set(bearer(tok.fixed))).body.step.nextStep;
    expect(next.mode).toBe('chosen');
    expect(next.list).toBeUndefined();
    const offered = next.candidates.map((c: { userId: number }) => c.userId);
    expect(offered).toEqual(expect.arrayContaining([ids.sue, ids.pay, ids.admin]));
    expect(offered).not.toContain(ids.fixed); // the chooser
    expect(offered).not.toContain(ids.sam); // the submitter, who is no approver anyway
    expect(offered).not.toContain(ids.dee); // deactivated

    expect((await decide('fixed', first.RequestStepId, { decision: 'approve', nextApproverKey: 'Hawes' })).body.error.details[0].message).toContain('not in the list');
    expect((await decide('fixed', first.RequestStepId, { decision: 'approve', nextApproverUserId: ids.sam })).status).toBe(400); // not an approver
    expect((await decide('fixed', first.RequestStepId, { decision: 'approve', nextApproverUserId: ids.pay })).body.nextStepOrder).toBe(2);
    expect((await stepsOf(created.body.requestId))[1].AssignedUserId).toBe(ids.pay);
  });

  it('protects the files and columns a step picks from', async () => {
    await publish(chain());
    expect((await request(app).delete(`${api}/admin/lookups/${lists.principals}`).set(bearer(tok.admin))).status).toBe(409);
    const replace = await request(app).put(`${api}/admin/lookups/${lists.principals}/import`).set(bearer(tok.admin)).set('Content-Type', 'application/octet-stream')
      .send(await xlsx(PRINCIPALS.map((r) => r.slice(0, 3)))); // drops Phone, which the step shows
    expect(replace.status).toBe(409);
    expect(JSON.stringify(replace.body)).toContain('Phone');
  });
});
