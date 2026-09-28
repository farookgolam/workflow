import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processArchive } from '../src/archive/worker';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};
const SIGNED = { strokes: [[10.04, 20, 300, 150], [7, 7]] };

async function newRequest() {
  const res = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { note: 'hi' } });
  expect(res.status).toBe(201);
  const steps = await tenantQuery<{ RequestStepId: number }>(t.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R ORDER BY StepOrder', { R: res.body.requestId });
  return { requestId: res.body.requestId as number, steps: steps.map((s) => s.RequestStepId) };
}
const decide = (as: string, stepId: number, body: object) => request(app).post(`${api}/approvals/${stepId}/decision`).set(bearer(tok[as])).send(body);
const stepStatus = async (stepId: number) =>
  (await tenantQuery<{ Status: string; Signature: string | null }>(t.tenantId, 'SELECT Status, Signature FROM RequestSteps WHERE TenantId = @TenantId AND RequestStepId = @S', { S: stepId }))[0];

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ann: ['Approver'], bob: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@stepsig.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@stepsig.test`)).body.accessToken;
  }
  const created = await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Signed steps', slug: 'signed-steps', fields: [{ key: 'note', label: 'Note', type: 'text' }] });
  expect(created.status).toBe(201);
  formId = created.body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Check', approverUserId: ids.ann }, { name: 'Sign off', approverUserId: ids.bob }] });
});
afterAll(closePool);

describe('approver signature on every step', () => {
  it('will not approve without a drawn signature, and leaves the step open', async () => {
    const r = await newRequest();
    for (const signature of [undefined, { strokes: [] }, { strokes: [[]] }]) {
      const res = await decide('ann', r.steps[0], { decision: 'approve', signature });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0]).toEqual({ path: 'signature', message: 'Sign to approve' });
    }
    for (const signature of ['ANN', 'data:image/png;base64,AAAA', { strokes: [[1, 2, 3]] }, { strokes: [['<svg>', 2]] }]) {
      const res = await decide('ann', r.steps[0], { decision: 'approve', signature });
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].path).toBe('signature');
    }
    expect(await stepStatus(r.steps[0])).toEqual({ Status: 'Active', Signature: null });
  });

  it('rejects without a signature', async () => {
    const r = await newRequest();
    expect((await decide('ann', r.steps[0], { decision: 'reject', rejectionReason: 'No' })).body.requestStatus).toBe('Rejected');
    expect(await stepStatus(r.steps[0])).toEqual({ Status: 'Rejected', Signature: null });
  });

  it('keeps the signature with the step, shows it to later approvers and admins but not on the submitter page, and prints it', async () => {
    const r = await newRequest();
    expect((await decide('ann', r.steps[0], { decision: 'approve', signature: SIGNED })).body.nextStepOrder).toBe(2);
    const stored = (await stepStatus(r.steps[0])).Signature!;
    expect(JSON.parse(stored)).toEqual({ w: 600, h: 200, strokes: [[10, 20, 300, 150], [7, 7]] });

    expect((await request(app).get(`${api}/approvals/${r.steps[0]}`).set(bearer(tok.ann))).body.step.decided.signature).toBe(stored);
    expect((await request(app).get(`${api}/approvals/${r.steps[1]}`).set(bearer(tok.bob))).body.previousSteps[0].signature).toBe(stored);
    expect((await request(app).get(`${api}/admin/requests/${r.requestId}`).set(bearer(tok.admin))).body.request.steps[0].signature).toBe(stored);
    expect(JSON.stringify((await request(app).get(`${api}/my/requests/${r.requestId}`).set(bearer(tok.sam))).body)).not.toContain('strokes');

    expect((await decide('bob', r.steps[1], { decision: 'approve', signature: SIGNED })).body.requestStatus).toBe('Approved');
    expect((await processArchive({ tenantId: t.tenantId })).generated).toBeGreaterThanOrEqual(1);
    expect((await request(app).get(`${api}/admin/requests/${r.requestId}/pdf`).set(bearer(tok.admin))).status).toBe(200);
  });

  it('cannot be changed once the step is decided', async () => {
    const r = await newRequest();
    await decide('ann', r.steps[0], { decision: 'approve', signature: SIGNED });
    await expect(tenantQuery(t.tenantId, "UPDATE RequestSteps SET Signature = N'{}' WHERE TenantId = @TenantId AND RequestStepId = @S", { S: r.steps[0] })).rejects.toThrow(/cannot be modified/);
  });
});
