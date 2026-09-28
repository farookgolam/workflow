import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery, unscopedQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser, recordStepAnswers } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

const goodValues = { title: 'New laptop', amount: 1499.5, neededBy: '2026-11-01', category: 'Hardware', urgent: true };

async function submit(values: Record<string, unknown> = goodValues, as = 'sam') {
  return request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok[as])).send({ values });
}
async function stepsOf(requestId: number) {
  return tenantQuery<{ RequestStepId: number; StepOrder: number; Status: string }>(
    t.tenantId,
    'SELECT RequestStepId, StepOrder, Status FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R ORDER BY StepOrder',
    { R: requestId },
  );
}
const decide = (as: string, requestStepId: number, body: Record<string, unknown>) =>
  request(app).post(`${api}/approvals/${requestStepId}/decision`).set(bearer(tok[as])).send(body);
const mailTypes = async (requestId: number) =>
  (await tenantQuery<{ Type: string; RecipientEmail: string }>(
    t.tenantId,
    'SELECT Type, RecipientEmail FROM Notifications WHERE TenantId = @TenantId AND RequestId = @R ORDER BY NotificationId',
    { R: requestId },
  )).map((n) => `${n.Type}>${n.RecipientEmail.split('@')[0]}`);

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], sue: ['Submitter'], ann: ['Approver'], bob: ['Approver'], cat: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@wf.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@wf.test`)).body.accessToken;
  }
  const form = await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({
    name: 'Purchase Request',
    slug: 'purchase',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'amount', label: 'Amount', type: 'currency', required: true, rules: { min: 0.01, max: 100000 } },
      { key: 'neededBy', label: 'Needed by', type: 'date' },
      { key: 'category', label: 'Category', type: 'select', required: true, options: ['Hardware', 'Software'] },
      { key: 'urgent', label: 'Urgent', type: 'checkbox' },
    ],
  });
  expect(form.status).toBe(201);
  formId = form.body.formId;

  const chain = await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({
    steps: [
      { name: 'Manager', approverUserId: ids.ann, reminderAfterDays: 3 },
      { name: 'Finance', approverUserId: ids.bob },
      { name: 'Director', approverUserId: ids.cat },
    ],
  });
  expect(chain.body).toMatchObject({ version: 1 });
});
afterAll(closePool);

describe('submission', () => {
  it('validates server-side against the form definition', async () => {
    const res = await submit({ title: '  ', amount: 'lots', neededBy: '2026-02-30', category: 'Snacks', sneaky: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['amount', 'category', 'neededBy', 'sneaky', 'title']);
    expect((await submit({ ...goodValues, amount: 100001 })).status).toBe(400);
  });

  it('only submitters can submit; unknown forms are 404', async () => {
    expect((await submit(goodValues, 'ann')).status).toBe(403);
    expect((await request(app).post(`${api}/forms/999999/requests`).set(bearer(tok.sam)).send({ values: goodValues })).status).toBe(404);
  });

  it('creates the request, snapshots data, activates step 1 and queues both emails', async () => {
    const res = await submit();
    expect(res.status).toBe(201);
    expect(res.body.requestNumber).toMatch(/^REQ-\d{6}$/);

    expect((await stepsOf(res.body.requestId)).map((s) => s.Status)).toEqual(['Active', 'Waiting', 'Waiting']);
    expect(await mailTypes(res.body.requestId)).toEqual(['SubmissionReceived>sam', 'ApprovalRequested>ann']);

    const mine = await request(app).get(`${api}/my/requests/${res.body.requestId}`).set(bearer(tok.sam));
    expect(mine.body.request.progress.label).toBe('Step 1 of 3, waiting on ANN');
    expect(mine.body.request.data.find((d: { key: string }) => d.key === 'amount').value).toBe('1499.50');
    // step 1 has a due date because reminderAfterDays is set
    const [s1] = await tenantQuery<{ DueAt: Date | null }>(t.tenantId, 'SELECT DueAt FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R AND StepOrder = 1', { R: res.body.requestId });
    expect(s1.DueAt).toBeInstanceOf(Date);
  });

  it("submitters cannot see each other's requests", async () => {
    const { body } = await submit();
    expect((await request(app).get(`${api}/my/requests/${body.requestId}`).set(bearer(tok.sue))).status).toBe(404);
    expect((await request(app).get(`${api}/my/requests`).set(bearer(tok.sue))).body.requests).toEqual([]);
  });
});

describe('approval path', () => {
  it('walks Step 1..N to Approved, notifying each approver in turn and the submitter at the end', async () => {
    const { body } = await submit();
    const [s1, s2, s3] = await stepsOf(body.requestId);

    // wrong person, wrong order
    expect((await decide('bob', s1.RequestStepId, { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] } })).status).toBe(404);
    expect((await decide('bob', s2.RequestStepId, { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] } })).body.error.code).toBe('step_not_active');

    const a1 = await decide('ann', s1.RequestStepId, { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] }, comments: 'Fine by me' });
    expect(a1.body).toEqual({ requestStatus: 'InProgress', nextStepOrder: 2 });

    // a step cannot be acted on twice
    const again = await decide('ann', s1.RequestStepId, { decision: 'reject', rejectionReason: 'changed my mind' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('step_already_decided');

    expect((await decide('bob', s2.RequestStepId, { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] } })).body.nextStepOrder).toBe(3);
    const last = await decide('cat', s3.RequestStepId, { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] } });
    expect(last.body).toEqual({ requestStatus: 'Approved', nextStepOrder: null });

    expect(await mailTypes(body.requestId)).toEqual([
      'SubmissionReceived>sam', 'ApprovalRequested>ann', 'ApprovalRequested>bob', 'ApprovalRequested>cat', 'FinalApproved>sam',
    ]);
    const [r] = await tenantQuery<{ Status: string; CurrentStepOrder: number | null; ArchiveStatus: string }>(
      t.tenantId, 'SELECT Status, CurrentStepOrder, ArchiveStatus FROM Requests WHERE TenantId = @TenantId AND RequestId = @R', { R: body.requestId });
    expect(r).toEqual({ Status: 'Approved', CurrentStepOrder: null, ArchiveStatus: 'PdfPending' });

    // approver comments are hidden from the submitter by default
    const mine = (await request(app).get(`${api}/my/requests/${body.requestId}`).set(bearer(tok.sam))).body.request;
    expect(mine.steps[0]).toMatchObject({ status: 'Approved', approver: 'ANN' });
    expect(mine.steps[0].comments).toBeUndefined();

    const actions = (await tenantQuery<{ Action: string; IpAddress: string | null }>(
      t.tenantId, 'SELECT Action, IpAddress FROM AuditLog WHERE TenantId = @TenantId AND RequestId = @R ORDER BY AuditId', { R: body.requestId }));
    expect(actions.map((a) => a.Action)).toEqual([
      'request.submitted', 'step.activated', 'step.approved', 'step.activated', 'step.approved', 'step.activated', 'step.approved', 'request.approved',
    ]);
    expect(actions.every((a) => a.IpAddress)).toBe(true);
  });

  it('two simultaneous decisions on one step: exactly one wins', async () => {
    const { body } = await submit();
    const [s1] = await stepsOf(body.requestId);
    const results = await Promise.all([
      decide('ann', s1.RequestStepId, { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] } }),
      decide('ann', s1.RequestStepId, { decision: 'reject', rejectionReason: 'No budget' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('honours the emailed link token only for its own user and step', async () => {
    const { body } = await submit();
    const [s1] = await stepsOf(body.requestId);
    const bad = await decide('ann', s1.RequestStepId, { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] }, token: 'x'.repeat(43) });
    expect(bad.status).toBe(403);
    const [mail] = await tenantQuery<{ BodyHtml: string }>(
      t.tenantId, `SELECT BodyHtml FROM Notifications WHERE TenantId = @TenantId AND RequestId = @R AND Type = 'ApprovalRequested'`, { R: body.requestId });
    const token = /token=([\w-]+)/.exec(mail.BodyHtml)![1];
    expect((await decide('ann', s1.RequestStepId, { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] }, token })).status).toBe(200);
    const [row] = await tenantQuery<{ Consumed: number }>(
      t.tenantId, 'SELECT CASE WHEN ConsumedAt IS NULL THEN 0 ELSE 1 END AS Consumed FROM ApprovalTokens WHERE TenantId = @TenantId AND RequestStepId = @S', { S: s1.RequestStepId });
    expect(row.Consumed).toBe(1);
  });
});

describe('rejection', () => {
  it('requires a reason, stops the workflow, and is final', async () => {
    const { body } = await submit();
    const [s1, s2, s3] = await stepsOf(body.requestId);
    await decide('ann', s1.RequestStepId, { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] } });
    await recordStepAnswers(t.tenantId, s1.RequestStepId, [{ key: 'costCode', label: 'Cost code', type: 'text', value: 'AB-1234' }]); // answered under an older chain

    const noReason = await decide('bob', s2.RequestStepId, { decision: 'reject', rejectionReason: '   ' });
    expect(noReason.status).toBe(400);

    const rej = await decide('bob', s2.RequestStepId, { decision: 'reject', rejectionReason: 'Over budget for Q4' });
    expect(rej.body).toEqual({ requestStatus: 'Rejected', nextStepOrder: null });

    expect((await stepsOf(body.requestId)).map((s) => s.Status)).toEqual(['Approved', 'Rejected', 'NotReached']);
    // step 3 approver was never notified; submitter and admin were
    expect(await mailTypes(body.requestId)).toEqual([
      'SubmissionReceived>sam', 'ApprovalRequested>ann', 'ApprovalRequested>bob', 'Rejected>sam', 'AdminRejectedAlert>admin',
    ]);
    const [mail] = await tenantQuery<{ BodyHtml: string }>(
      t.tenantId, `SELECT BodyHtml FROM Notifications WHERE TenantId = @TenantId AND RequestId = @R AND Type = 'Rejected'`, { R: body.requestId });
    expect(mail.BodyHtml).toContain('Over budget for Q4');
    expect(mail.BodyHtml).toContain('Step 2 of 3 - Finance');
    expect(mail.BodyHtml).toContain('BOB');

    // cannot be resumed by anyone, through the API or straight in the database
    expect((await decide('cat', s3.RequestStepId, { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] } })).body.error.code).toBe('request_closed');
    expect((await request(app).post(`${api}/admin/requests/${body.requestId}/cancel`).set(bearer(tok.admin)).send({ reason: 'x' })).status).toBe(409);
    await expect(unscopedQuery(`UPDATE Requests SET Status = 'InProgress', CurrentStepOrder = 2 WHERE RequestId = @R`, { R: body.requestId })).rejects.toThrow(/final/);
    await expect(unscopedQuery(`UPDATE RequestSteps SET Status = 'Active' WHERE RequestStepId = @S`, { S: s2.RequestStepId })).rejects.toThrow(/cannot be modified/);
    await expect(unscopedQuery(`UPDATE StepResponses SET Value = 'ZZ-0000' WHERE RequestStepId = @S`, { S: s1.RequestStepId })).rejects.toThrow(/immutable/);

    const mine = (await request(app).get(`${api}/my/requests/${body.requestId}`).set(bearer(tok.sam))).body.request;
    expect(mine.status).toBe('Rejected');
    expect(mine.rejection).toMatchObject({ reason: 'Over budget for Q4', stepOrder: 2, stepName: 'Finance', rejectedBy: 'BOB' });
  });

  it('a rejected decision with invalid data rolls back completely', async () => {
    const { body } = await submit();
    const [s1] = await stepsOf(body.requestId);
    expect((await decide('ann', s1.RequestStepId, { decision: 'reject', fields: { bogus: 1 }, rejectionReason: 'r' })).status).toBe(400);
    expect((await stepsOf(body.requestId))[0].Status).toBe('Active');
  });
});

describe('admin cancel and chain versioning', () => {
  it('cancel closes the request, revokes the link and notifies the submitter', async () => {
    const { body } = await submit();
    const [s1] = await stepsOf(body.requestId);
    expect((await request(app).post(`${api}/admin/requests/${body.requestId}/cancel`).set(bearer(tok.sam)).send({ reason: 'x' })).status).toBe(403);
    expect((await request(app).post(`${api}/admin/requests/${body.requestId}/cancel`).set(bearer(tok.admin)).send({ reason: 'Duplicate' })).status).toBe(204);
    expect((await stepsOf(body.requestId)).map((s) => s.Status)).toEqual(['Cancelled', 'Cancelled', 'Cancelled']);
    expect((await decide('ann', s1.RequestStepId, { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] } })).status).toBe(409);
    expect(await mailTypes(body.requestId)).toContain('Cancelled>sam');
  });

  it('in-flight requests keep their chain version when the chain is republished', async () => {
    const before = await submit();
    const v2 = await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin))
      .send({ steps: [{ name: 'Only step', approverUserId: ids.cat }] });
    expect(v2.body.version).toBe(2);
    const after = await submit();
    expect(await stepsOf(before.body.requestId)).toHaveLength(3);
    expect(await stepsOf(after.body.requestId)).toHaveLength(1);

    const [only] = await stepsOf(after.body.requestId);
    expect((await decide('cat', only.RequestStepId, { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] } })).body.requestStatus).toBe('Approved');
  });

  it("rejects a chain that names another tenant's user or a non-approver", async () => {
    const other = await makeTenant();
    const outsider = await makeUser(other.tenantId, 'outsider@wf.test', ['Approver']);
    const put = (approverUserId: number) =>
      request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'S', approverUserId }] });
    expect((await put(outsider)).body.error.code).toBe('invalid_user');
    expect((await put(ids.sam)).body.error.code).toBe('not_an_approver');
  });
});

describe('approvers fill in no controls', () => {
  let fid: number;
  const chain = (steps: unknown[]) => request(app).put(`${api}/admin/forms/${fid}/chain`).set(bearer(tok.admin)).send({ steps });
  beforeAll(async () => {
    fid = (await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Plain', slug: 'plain', fields: [{ key: 'title', label: 'Title', type: 'text' }] })).body.formId;
  });

  it('a chain step with controls is refused; an empty list is fine', async () => {
    const bad = await chain([{ name: 'Manager', approverUserId: ids.ann, fields: [{ key: 'costCode', label: 'Cost code', type: 'text' }] }]);
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body.error)).toMatch(/no longer fill in controls/);
    const ok = await chain([{ name: 'Manager', approverUserId: ids.ann, fields: [] }]);
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(1);

    const editor = (await request(app).get(`${api}/admin/forms/${fid}`).set(bearer(tok.admin))).body;
    expect(editor.steps).toHaveLength(1);
    expect(editor.steps[0]).not.toHaveProperty('fields');
  });

  it('a decision carrying values is refused and leaves the step active; the approval page offers no controls', async () => {
    const res = await request(app).post(`${api}/forms/${fid}/requests`).set(bearer(tok.sam)).send({ values: { title: 'x' } });
    const [s1] = await stepsOf(res.body.requestId);
    const page = (await request(app).get(`${api}/approvals/${s1.RequestStepId}`).set(bearer(tok.ann))).body;
    expect(page.step).toMatchObject({ canAct: true });
    expect(page.step).not.toHaveProperty('fields');

    expect((await decide('ann', s1.RequestStepId, { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] }, fields: { x: 1 } })).status).toBe(400);
    expect((await stepsOf(res.body.requestId))[0].Status).toBe('Active');
    expect((await decide('ann', s1.RequestStepId, { decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] }, fields: {} })).body.requestStatus).toBe('Approved');
  });
});
