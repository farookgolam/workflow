import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
const SIGNED = { strokes: [[10, 10, 90, 40]] };
let t: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

const values = { title: 'New laptop', amount: 1499.5, urgent: true };
const submit = async () => (await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values })).body.requestId as number;
const stepsOf = (requestId: number) =>
  tenantQuery<{ RequestStepId: number; StepOrder: number; Status: string }>(
    t.tenantId, 'SELECT RequestStepId, StepOrder, Status FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R ORDER BY StepOrder', { R: requestId });
const decide = (as: string, id: number, body: Record<string, unknown>) => request(app).post(`${api}/approvals/${id}/decision`).set(bearer(tok[as])).send(body);
const resubmit = (as: string, requestId: number, body: Record<string, unknown>) => request(app).post(`${api}/my/requests/${requestId}/resubmit`).set(bearer(tok[as])).send(body);
const mails = (requestId: number) =>
  tenantQuery<{ Type: string; RecipientEmail: string; Subject: string; BodyHtml: string }>(
    t.tenantId, 'SELECT Type, RecipientEmail, Subject, BodyHtml FROM Notifications WHERE TenantId = @TenantId AND RequestId = @R ORDER BY NotificationId', { R: requestId });

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], sue: ['Submitter'], ann: ['Approver'], bob: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@sb.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@sb.test`)).body.accessToken;
  }
  formId = (await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({
    name: 'Purchase', slug: 'purchase',
    fields: [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'amount', label: 'Amount', type: 'currency', required: true },
      { key: 'urgent', label: 'Urgent', type: 'checkbox' },
    ],
  })).body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({
    steps: [{ name: 'Manager', approverUserId: ids.ann }, { name: 'Finance', approverUserId: ids.bob }],
  });
});
afterAll(closePool);

describe('send back for changes', () => {
  it('needs a reason, and returns the step to the submitter without closing the request', async () => {
    const id = await submit();
    const [s1] = await stepsOf(id);
    const none = await decide('ann', s1.RequestStepId, { decision: 'return', returnReason: '  ' });
    expect(none.status).toBe(400);
    expect(none.body.error.details[0].path).toBe('returnReason');

    const res = await decide('ann', s1.RequestStepId, { decision: 'return', returnReason: 'Add the quote number' });
    expect(res.body).toEqual({ requestStatus: 'Returned', nextStepOrder: null });
    expect((await stepsOf(id)).map((s) => s.Status)).toEqual(['Returned', 'Waiting']);

    // off the approver's list, and they cannot act on it now
    expect((await request(app).get(`${api}/approvals/pending`).set(bearer(tok.ann))).body.approvals).toEqual([]);
    expect((await decide('ann', s1.RequestStepId, { decision: 'approve', signature: SIGNED })).status).toBe(409);
    const page = (await request(app).get(`${api}/approvals/${s1.RequestStepId}`).set(bearer(tok.ann))).body;
    expect(page.step).toMatchObject({ status: 'Returned', canAct: false, decided: null });
    expect(page.returns).toMatchObject([{ stepOrder: 1, returnedBy: 'ANN', reason: 'Add the quote number', resubmittedAt: null }]);

    // the submitter is told why, sees it on their list and on the request
    const sent = (await mails(id)).at(-1)!;
    expect(sent).toMatchObject({ Type: 'SentBack', RecipientEmail: 'sam@sb.test' });
    expect(sent.BodyHtml).toContain('Add the quote number');
    expect(sent.BodyHtml).toContain(`/requests/${id}/edit`);
    const mine = (await request(app).get(`${api}/my/requests?status=Returned`).set(bearer(tok.sam))).body.requests;
    expect(mine).toMatchObject([{ requestId: id, status: 'InProgress', waitingOn: null, sentBack: { reason: 'Add the quote number', returnedBy: 'ANN' } }]);
    const detail = (await request(app).get(`${api}/my/requests/${id}`).set(bearer(tok.sam))).body.request;
    expect(detail.sentBack).toMatchObject({ stepOrder: 1, returnedBy: 'ANN', reason: 'Add the quote number' });
    expect(detail.progress.label).toBe('Sent back to you for changes by ANN');
  });

  it('resubmitting records what changed and reopens the same step for the same approver', async () => {
    const id = await submit();
    const [s1, s2] = await stepsOf(id);
    await decide('ann', s1.RequestStepId, { decision: 'approve', signature: SIGNED });
    await decide('bob', s2.RequestStepId, { decision: 'return', returnReason: 'Too expensive, find a cheaper one' });

    expect((await resubmit('sue', id, { values })).status).toBe(404); // not hers
    const form = await request(app).get(`${api}/my/requests/${id}/form`).set(bearer(tok.sam));
    expect(form.body.fields.map((f: { key: string }) => f.key)).toEqual(['title', 'amount', 'urgent']);
    expect((await request(app).get(`${api}/my/requests/${id}/form`).set(bearer(tok.sue))).status).toBe(404);
    const bad = await resubmit('sam', id, { values: { ...values, title: '' } });
    expect(bad.status).toBe(400); // validated like a new submission
    expect((await stepsOf(id)).map((s) => s.Status)).toEqual(['Approved', 'Returned']);

    const ok = await resubmit('sam', id, { values: { ...values, amount: 999, urgent: false }, note: 'Found a cheaper model' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ requestId: id, stepOrder: 2, changes: 2 });
    // step 1 keeps its approval; step 2 is live again
    expect((await stepsOf(id)).map((s) => s.Status)).toEqual(['Approved', 'Active']);

    const mail = (await mails(id)).at(-1)!;
    expect(mail).toMatchObject({ Type: 'Resubmitted', RecipientEmail: 'bob@sb.test' });
    expect(mail.BodyHtml).toContain('1499.50 → 999.00');
    expect(mail.BodyHtml).toContain('Found a cheaper model');

    const page = (await request(app).get(`${api}/approvals/${s2.RequestStepId}`).set(bearer(tok.bob))).body;
    expect(page.step.canAct).toBe(true);
    expect(page.submission.find((f: { key: string }) => f.key === 'amount').value).toBe('999.00');
    expect(page.returns[0]).toMatchObject({ resubmitNote: 'Found a cheaper model', changes: [
      { key: 'amount', label: 'Amount', type: 'currency', from: '1499.50', to: '999.00' },
      { key: 'urgent', label: 'Urgent', type: 'checkbox', from: 'true', to: 'false' },
    ] });
    // step 1's approver does not see a later step's send-back
    expect((await request(app).get(`${api}/approvals/${s1.RequestStepId}`).set(bearer(tok.ann))).body.returns).toEqual([]);

    // a second resubmit is refused, and the chain finishes normally
    expect((await resubmit('sam', id, { values })).status).toBe(409);
    expect((await decide('bob', s2.RequestStepId, { decision: 'approve', signature: SIGNED })).body.requestStatus).toBe('Approved');
  });

  it('a send-back record can only be completed once', async () => {
    const id = await submit();
    const [s1] = await stepsOf(id);
    await decide('ann', s1.RequestStepId, { decision: 'return', returnReason: 'x' });
    await resubmit('sam', id, { values });
    await expect(tenantQuery(t.tenantId, `UPDATE RequestReturns SET Reason = N'changed' WHERE TenantId = @TenantId AND RequestId = @R`, { R: id })).rejects.toThrow(/completed once/);
    await expect(tenantQuery(t.tenantId, 'DELETE FROM RequestReturns WHERE TenantId = @TenantId AND RequestId = @R', { R: id })).rejects.toThrow(/cannot be removed/);
  });

  it('an administrator can cancel a request while it is with the submitter', async () => {
    const id = await submit();
    const [s1] = await stepsOf(id);
    await decide('ann', s1.RequestStepId, { decision: 'return', returnReason: 'x' });
    const list = (await request(app).get(`${api}/admin/requests`).set(bearer(tok.admin))).body.requests;
    expect(list.find((r: { requestId: number }) => r.requestId === id).waitingOn).toBe('SAM (sent back for changes)');
    expect((await request(app).post(`${api}/admin/requests/${id}/cancel`).set(bearer(tok.admin)).send({ reason: 'dup' })).status).toBe(204);
    expect((await stepsOf(id)).map((s) => s.Status)).toEqual(['Cancelled', 'Cancelled']);
    expect((await resubmit('sam', id, { values })).status).toBe(409);
  });
});

describe('approval email', () => {
  it('lists the submitted values and has Approve / Send back / Reject buttons', async () => {
    const id = await submit();
    const mail = (await mails(id)).find((m) => m.Type === 'ApprovalRequested')!;
    expect(mail.BodyHtml).toContain('Request details');
    expect(mail.BodyHtml).toContain('New laptop');
    expect(mail.BodyHtml).toMatch(/token=[\w-]+&#38;do=approve/);
    expect(mail.BodyHtml).toMatch(/token=[\w-]+&#38;do=return/);
    expect(mail.BodyHtml).toMatch(/token=[\w-]+&#38;do=reject/);
  });

  it('leaves the values out when the customer turns that off', async () => {
    await request(app).patch(`${api}/admin/settings`).set(bearer(tok.admin)).send({ emailShowDetails: false });
    try {
      const id = await submit();
      const mail = (await mails(id)).find((m) => m.Type === 'ApprovalRequested')!;
      expect(mail.BodyHtml).not.toContain('New laptop');
      expect(mail.BodyHtml).toContain('do=approve');
    } finally {
      await request(app).patch(`${api}/admin/settings`).set(bearer(tok.admin)).send({ emailShowDetails: null });
    }
  });
});
