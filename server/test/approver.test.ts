import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { processOutbox, type OutgoingMail } from '../src/notifications/mailer';
import { app, bearer, login, makeTenant, makeUser, recordStepAnswers } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

const get = (as: string, url: string) => request(app).get(`${api}${url}`).set(bearer(tok[as]));
const decide = (as: string, id: number, body: Record<string, unknown>) =>
  request(app).post(`${api}/approvals/${id}/decision`).set(bearer(tok[as])).send(body);

async function submit() {
  const res = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { title: 'Trip to client', cost: 420 } });
  const steps = await tenantQuery<{ RequestStepId: number }>(
    t.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R ORDER BY StepOrder', { R: res.body.requestId });
  return { requestId: res.body.requestId as number, steps: steps.map((s) => s.RequestStepId) };
}
async function linkToken(requestStepId: number) {
  const [mail] = await tenantQuery<{ BodyHtml: string }>(
    t.tenantId, `SELECT TOP 1 BodyHtml FROM Notifications WHERE TenantId = @TenantId AND RequestStepId = @S AND Type = 'ApprovalRequested' ORDER BY NotificationId DESC`, { S: requestStepId });
  return /token=([\w-]+)/.exec(mail.BodyHtml)![1];
}

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ann: ['Approver'], bob: ['Approver'], cat: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@ap.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@ap.test`)).body.accessToken;
  }
  formId = (await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({
    name: 'Travel', slug: 'travel',
    fields: [{ key: 'title', label: 'Trip', type: 'text', required: true }, { key: 'cost', label: 'Cost', type: 'currency', required: true }],
  })).body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({
    steps: [
      { name: 'Manager', approverUserId: ids.ann },
      { name: 'Finance', approverUserId: ids.bob },
      { name: 'Director', approverUserId: ids.cat },
    ],
  });
});
afterAll(closePool);

describe('approval link', () => {
  it('requires sign-in AND must belong to the signed-in user', async () => {
    const { steps } = await submit();
    const token = await linkToken(steps[0]);

    expect((await request(app).get(`${api}/approvals/resolve?token=${token}`)).status).toBe(401);
    expect((await get('bob', `/approvals/resolve?token=${token}`)).status).toBe(403); // forwarded link
    expect((await get('sam', `/approvals/resolve?token=${token}`)).status).toBe(403); // not an approver
    expect((await get('ann', `/approvals/resolve?token=${'z'.repeat(43)}`)).status).toBe(403);

    const ok = await get('ann', `/approvals/resolve?token=${token}`);
    expect(ok.body).toEqual({ requestStepId: steps[0] });
  });

  it('is revoked when the request is cancelled', async () => {
    const { requestId, steps } = await submit();
    const token = await linkToken(steps[0]);
    await request(app).post(`${api}/admin/requests/${requestId}/cancel`).set(bearer(tok.admin)).send({ reason: 'dup' });
    expect((await get('ann', `/approvals/resolve?token=${token}`)).status).toBe(403);
  });
});

describe('approver page', () => {
  it('shows submission + earlier decisions read-only, no controls of its own, nothing from later steps', async () => {
    const { steps } = await submit();

    const p1 = (await get('ann', `/approvals/${steps[0]}`)).body;
    expect(p1.submission.map((d: { key: string; value: string }) => [d.key, d.value])).toEqual([['title', 'Trip to client'], ['cost', '420.00']]);
    expect(p1.previousSteps).toEqual([]);
    expect(p1.step).toMatchObject({ stepOrder: 1, canAct: true, decided: null });
    expect(p1.step).not.toHaveProperty('fields');

    // Bob's step is not active yet: he can look but not act; Cat (step 3) and Sam cannot open step 1 at all
    expect((await get('bob', `/approvals/${steps[1]}`)).body.step).toMatchObject({ canAct: false, status: 'Waiting' });
    expect((await get('cat', `/approvals/${steps[0]}`)).status).toBe(404);
    expect((await get('sam', `/approvals/${steps[0]}`)).status).toBe(403);

    await decide('ann', steps[0], { decision: 'approve', comments: 'Client asked for this' });
    await recordStepAnswers(t.tenantId, steps[0], [{ key: 'costCode', label: 'Cost code', type: 'text', value: 'TR-1' }]); // answered under an older chain

    const p2 = (await get('bob', `/approvals/${steps[1]}`)).body;
    expect(p2.previousSteps).toEqual([
      expect.objectContaining({ stepOrder: 1, name: 'Manager', decision: 'Approved', actedBy: 'ANN', comments: 'Client asked for this', responses: [expect.objectContaining({ key: 'costCode', value: 'TR-1' })] }),
    ]);
    expect(p2.step.canAct).toBe(true);

    // Ann reopens her link after deciding: read-only
    const again = (await get('ann', `/approvals/${steps[0]}`)).body.step;
    expect(again.canAct).toBe(false);
    expect(again.decided).toMatchObject({ decision: 'Approved', comments: 'Client asked for this', responses: [expect.objectContaining({ key: 'costCode', value: 'TR-1' })] });
  });

  it('pending inbox lists only my active steps', async () => {
    const { steps } = await submit();
    const mine = (await get('ann', '/approvals/pending')).body.approvals.map((a: { requestStepId: number }) => a.requestStepId);
    expect(mine).toContain(steps[0]);
    const bobs = (await get('bob', '/approvals/pending')).body.approvals.map((a: { requestStepId: number }) => a.requestStepId);
    expect(bobs).not.toContain(steps[0]);
    expect(bobs).not.toContain(steps[1]); // still Waiting
  });
});

describe('mail worker', () => {
  it('delivers queued mail once, retries failures with backoff, and parks them as Failed after max attempts', async () => {
    const { requestId } = await submit();
    const sentTo: OutgoingMail[] = [];
    const transport = {
      send: async (m: OutgoingMail) => {
        if (m.to.startsWith('ann@')) throw new Error('550 mailbox unavailable');
        sentTo.push(m);
      },
    };
    const drain = async () => { for (let r = await processOutbox(transport, 50); r.sent + r.failed > 0; r = await processOutbox(transport, 50)); };
    await drain();

    const state = async () => Object.fromEntries((await tenantQuery<{ RecipientEmail: string; Status: string; Attempts: number; LastError: string | null; Due: number }>(
      t.tenantId,
      `SELECT RecipientEmail, Status, Attempts, LastError, CASE WHEN NextAttemptAt > SYSUTCDATETIME() THEN 1 ELSE 0 END AS Due
         FROM Notifications WHERE TenantId = @TenantId AND RequestId = @R`, { R: requestId })).map((n) => [n.RecipientEmail, n]));

    let s = await state();
    expect(s['sam@ap.test']).toMatchObject({ Status: 'Sent', Attempts: 1 });
    expect(s['ann@ap.test']).toMatchObject({ Status: 'Queued', Attempts: 1, LastError: '550 mailbox unavailable', Due: 1 });

    const mine = sentTo.filter((m) => m.to === 'sam@ap.test' && m.subject.includes('We received'));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.at(-1)!.html).toContain('Track your request');
    expect(mine.at(-1)!.text).toMatch(/Track your request: http/);

    // backoff respected: nothing to do right now, and nothing is sent twice
    const before = sentTo.length;
    await drain();
    expect(sentTo.length).toBe(before);

    // fast-forward through the remaining attempts
    for (let i = 0; i < 5; i++) {
      await tenantQuery(t.tenantId, `UPDATE Notifications SET NextAttemptAt = NULL WHERE TenantId = @TenantId AND RequestId = @R AND Status = 'Queued'`, { R: requestId });
      await drain();
    }
    s = await state();
    expect(s['ann@ap.test']).toMatchObject({ Status: 'Failed', Attempts: 6 });
  });
});
