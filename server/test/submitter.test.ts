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
const my = (as: string, url: string) => request(app).get(`${api}/my${url}`).set(bearer(tok[as]));

async function submit(as: string, title: string) {
  const res = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok[as])).send({ values: { title } });
  const steps = await tenantQuery<{ RequestStepId: number }>(t.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R ORDER BY StepOrder', { R: res.body.requestId });
  return { requestId: res.body.requestId as number, steps: steps.map((s) => s.RequestStepId) };
}
const decide = (as: string, id: number, body: Record<string, unknown>) => request(app).post(`${api}/approvals/${id}/decision`).set(bearer(tok[as])).send(body);

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], sue: ['Submitter'], ann: ['Approver'], bob: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@sp.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@sp.test`)).body.accessToken;
  }
  formId = (await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Expense', slug: 'expense', fields: [{ key: 'title', label: 'Title', type: 'text', required: true }] })).body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({
    steps: [{ name: 'Manager', approverUserId: ids.ann }, { name: 'Finance', approverUserId: ids.bob }],
  });
});
afterAll(closePool);

describe('my submissions', () => {
  it('lists only my own requests with progress, rejection details and a status filter', async () => {
    const inFlight = await submit('sam', 'Taxi');
    const rejected = await submit('sam', 'Champagne');
    await submit('sue', "Sue's lunch");
    await decide('ann', rejected.steps[0], { decision: 'approve', comments: 'hmm' });
    await decide('bob', rejected.steps[1], { decision: 'reject', rejectionReason: 'Not a business expense' });

    const all = (await my('sam', '/requests')).body;
    expect(all.total).toBe(2);
    expect(all.requests.map((r: { requestId: number }) => r.requestId)).toEqual([rejected.requestId, inFlight.requestId]);
    expect(all.requests[1]).toMatchObject({ status: 'InProgress', currentStep: 1, totalSteps: 2, currentStepName: 'Manager', waitingOn: 'ANN', rejection: null, pdfAvailable: false });
    expect(all.requests[0]).toMatchObject({ status: 'Rejected', currentStep: null, rejection: { reason: 'Not a business expense', stepOrder: 2, stepName: 'Finance' } });

    expect((await my('sam', '/requests?status=Rejected')).body.requests).toHaveLength(1);
    expect((await my('sam', '/requests?status=Approved')).body.total).toBe(0);
    expect((await my('sue', '/requests')).body.total).toBe(1);
    // approvers without the Submitter role simply have none
    expect((await my('ann', '/requests')).body.total).toBe(0);
  });

  it('detail shows decision history; approver-entered content only when the form allows it', async () => {
    const r = await submit('sam', 'Hotel');
    await decide('ann', r.steps[0], { decision: 'approve', comments: 'between us' });
    await recordStepAnswers(t.tenantId, r.steps[0], [{ key: 'note', label: 'Internal note', type: 'text', value: 'internal only' }]); // entered under an older chain
    await decide('bob', r.steps[1], { decision: 'reject', rejectionReason: 'Over the nightly cap' });

    let d = (await my('sam', `/requests/${r.requestId}`)).body.request;
    expect(d.rejection).toMatchObject({ reason: 'Over the nightly cap', stepOrder: 2, stepName: 'Finance', rejectedBy: 'BOB' });
    expect(d.steps.map((s: { status: string; approver: string }) => [s.status, s.approver])).toEqual([['Approved', 'ANN'], ['Rejected', 'BOB']]);
    expect(JSON.stringify(d)).not.toContain('internal only');
    expect(JSON.stringify(d)).not.toContain('between us');
    expect(JSON.stringify(d)).not.toMatch(/actedIp|assignedUserId/);

    await request(app).patch(`${api}/admin/forms/${formId}`).set(bearer(tok.admin)).send({ submittersSeeComments: true });
    d = (await my('sam', `/requests/${r.requestId}`)).body.request;
    expect(d.steps[0]).toMatchObject({ comments: 'between us', responses: [expect.objectContaining({ key: 'note', value: 'internal only' })] });

    expect((await my('sue', `/requests/${r.requestId}`)).status).toBe(404);
  });
});
