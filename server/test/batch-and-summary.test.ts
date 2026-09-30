import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { runDailySummaries } from '../src/workflow/digest';
import { runSweep } from '../src/workflow/sweeper';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
const SIGNED = { strokes: [[10, 10, 90, 40]] };
let t: { tenantId: number; slug: string };
let fixedForm: number;
let chooseForm: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

const submit = async (formId: number, title = 'Laptop') =>
  (await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { title, amount: 100 } })).body.requestId as number;
const stepsOf = (requestId: number) =>
  tenantQuery<{ RequestStepId: number; Status: string }>(t.tenantId, 'SELECT RequestStepId, Status FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R ORDER BY StepOrder', { R: requestId });
const pending = async (as: string) => (await request(app).get(`${api}/approvals/pending`).set(bearer(tok[as]))).body.approvals;
const batch = (as: string, body: Record<string, unknown>) => request(app).post(`${api}/approvals/batch-approve`).set(bearer(tok[as])).send(body);
const mails = (type: string, to: string) =>
  tenantQuery<{ Subject: string; BodyHtml: string }>(t.tenantId, 'SELECT Subject, BodyHtml FROM Notifications WHERE TenantId = @TenantId AND Type = @T AND RecipientEmail = @E ORDER BY NotificationId', { T: type, E: to });
// a weekday morning after the summary hour (7:00 by default), in server time
const monday = (hour = 9) => new Date(2026, 9, 5, hour, 0, 0);

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ann: ['Approver'], bob: ['Approver'], dee: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@bs.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@bs.test`)).body.accessToken;
  }
  const fields = [{ key: 'title', label: 'Title', type: 'text', required: true }, { key: 'amount', label: 'Amount', type: 'currency' }];
  fixedForm = (await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Purchase', slug: 'purchase', fields })).body.formId;
  await request(app).put(`${api}/admin/forms/${fixedForm}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Manager', approverUserId: ids.ann }, { name: 'Finance', approverUserId: ids.bob }] });
  chooseForm = (await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Travel', slug: 'travel', fields })).body.formId;
  await request(app).put(`${api}/admin/forms/${chooseForm}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Manager', approverUserId: ids.ann }, { name: 'Next', chosen: {} }] });
});
afterAll(closePool);

describe('approve several at once', () => {
  it('lists what is waiting with a preview, and marks steps that need the next approver chosen', async () => {
    const a = await submit(fixedForm, 'Desk');
    const b = await submit(chooseForm, 'Trip');
    const list = await pending('ann');
    const byId = Object.fromEntries(list.map((p: { requestId: number }) => [p.requestId, p]));
    expect(byId[a]).toMatchObject({ choosesNext: false, preview: [{ label: 'Title', value: 'Desk' }, { label: 'Amount', value: '100.00' }] });
    expect(byId[b]).toMatchObject({ choosesNext: true, nextStep: { stepOrder: 2, name: 'Next', mode: 'chosen' } });
    // the choices offered for the next step: every approver except the one handing on and the submitter
    expect(byId[b].nextStep.candidates.map((c: { userId: number }) => c.userId)).toEqual(expect.arrayContaining([ids.bob, ids.dee]));
    expect(byId[b].nextStep.candidates.map((c: { userId: number }) => c.userId)).not.toContain(ids.ann);
    expect(byId[a].nextStep).toBeNull();
  });

  it('approves each with one signature, reports the ones it could not, and records the batch', async () => {
    const r1 = await submit(fixedForm);
    const r2 = await submit(fixedForm);
    const r3 = await submit(chooseForm);
    const [s1] = await stepsOf(r1);
    const [s2] = await stepsOf(r2);
    const [s3] = await stepsOf(r3);

    expect((await batch('ann', { requestStepIds: [s1.RequestStepId] })).status).toBe(400); // no signature
    const long = await batch('ann', { requestStepIds: [s1.RequestStepId], signature: SIGNED, comments: 'x'.repeat(3000), notes: { [s1.RequestStepId]: 'y'.repeat(1500) } });
    expect(long.status).toBe(400); // shared + own over 4000
    expect(long.body.error.details[0].path).toBe(`notes.${s1.RequestStepId}`);
    expect((await stepsOf(r1))[0].Status).toBe('Active');

    const res = await batch('ann', { requestStepIds: [s1.RequestStepId, s2.RequestStepId, s3.RequestStepId], signature: SIGNED, comments: 'All fine', notes: { [s2.RequestStepId]: '  Receipt checked  ' } });
    expect(res.status).toBe(200);
    expect(res.body.approved).toBe(2);
    expect(res.body.results).toEqual([
      { requestStepId: s1.RequestStepId, ok: true, requestStatus: 'InProgress', nextStepOrder: 2 },
      { requestStepId: s2.RequestStepId, ok: true, requestStatus: 'InProgress', nextStepOrder: 2 },
      { requestStepId: s3.RequestStepId, ok: false, message: 'Choose who approves "Next"' },
    ]);
    expect((await stepsOf(r1)).map((s) => s.Status)).toEqual(['Approved', 'Active']);
    expect((await stepsOf(r3)).map((s) => s.Status)).toEqual(['Active', 'Waiting']);

    // with the choice made in the batch, it goes through - to the person chosen
    const r5 = await submit(chooseForm);
    const [s5] = await stepsOf(r5);
    const withChoice = await batch('ann', { requestStepIds: [s3.RequestStepId, s5.RequestStepId], signature: SIGNED, next: { [s3.RequestStepId]: { userId: ids.bob }, [s5.RequestStepId]: { userId: ids.admin } } });
    expect(withChoice.body.approved).toBe(2);
    const assigned = await tenantQuery<{ RequestId: number; AssignedUserId: number }>(t.tenantId, 'SELECT RequestId, AssignedUserId FROM RequestSteps WHERE TenantId = @TenantId AND StepOrder = 2 AND RequestId IN (@A, @B)', { A: r3, B: r5 });
    expect(Object.fromEntries(assigned.map((x) => [x.RequestId, x.AssignedUserId]))).toEqual({ [r3]: ids.bob, [r5]: ids.admin });

    const [row] = await tenantQuery<{ Comments: string; Signature: string }>(t.tenantId, 'SELECT Comments, Signature FROM RequestSteps WHERE TenantId = @TenantId AND RequestStepId = @S', { S: s2.RequestStepId });
    expect(row.Comments).toBe('All fine\n\nReceipt checked'); // shared, then its own
    const [other] = await tenantQuery<{ Comments: string }>(t.tenantId, 'SELECT Comments FROM RequestSteps WHERE TenantId = @TenantId AND RequestStepId = @S', { S: s1.RequestStepId });
    expect(other.Comments).toBe('All fine');
    expect(row.Signature).toBeTruthy();
    const [a] = await tenantQuery<{ DetailJson: string }>(t.tenantId, `SELECT DetailJson FROM AuditLog WHERE TenantId = @TenantId AND Action = 'step.approved' AND EntityId = @S`, { S: s1.RequestStepId });
    expect(JSON.parse(a.DetailJson)).toMatchObject({ inBatch: true });

    // someone else's steps are not approved through a batch either
    const r4 = await submit(fixedForm);
    const [s4] = await stepsOf(r4);
    expect((await batch('bob', { requestStepIds: [s4.RequestStepId], signature: SIGNED })).body).toMatchObject({ approved: 0, results: [{ ok: false }] });
    expect((await batch('ann', { requestStepIds: Array.from({ length: 51 }, (_, i) => i + 1), signature: SIGNED })).status).toBe(400); // 50 at most
  });
});

describe('daily summary', () => {
  it('is each person\'s own choice', async () => {
    expect((await request(app).get(`${api}/my/preferences`).set(bearer(tok.dee))).body).toMatchObject({ emailDigest: false });
    expect((await request(app).put(`${api}/my/preferences`).set(bearer(tok.dee)).send({ emailDigest: true })).status).toBe(200);
    expect((await request(app).get(`${api}/my/preferences`).set(bearer(tok.dee))).body.emailDigest).toBe(true);
    const users = (await request(app).get(`${api}/admin/users`).set(bearer(tok.admin))).body.users;
    expect(users.find((u: { email: string }) => u.email === 'dee@bs.test').emailDigest).toBe(true);
  });

  it('replaces the per-request emails with one summary on weekday mornings, only when something is waiting', async () => {
    await request(app).put(`${api}/my/preferences`).set(bearer(tok.dee)).send({ emailDigest: true });
    await tenantQuery(t.tenantId, 'UPDATE Users SET LastDigestOn = NULL WHERE TenantId = @TenantId AND UserId = @U', { U: ids.dee });
    const form = (await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Leave', slug: 'leave', fields: [{ key: 'title', label: 'Title', type: 'text' }, { key: 'amount', label: 'Amount', type: 'currency' }] })).body.formId;
    await request(app).put(`${api}/admin/forms/${form}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Lead', approverUserId: ids.dee, reminderAfterDays: 1 }] });

    // nothing waiting yet: no summary
    expect(await runDailySummaries({ now: monday(), tenantId: t.tenantId })).toBe(0);

    const r1 = await submit(form, 'Day off');
    const r2 = await submit(form, 'Half day');
    expect(await mails('ApprovalRequested', 'dee@bs.test')).toEqual([]); // no per-request email
    const [s1] = await stepsOf(r1);
    // the scheduled reminder is left to the summary too
    await tenantQuery(t.tenantId, 'UPDATE RequestSteps SET ActivatedAt = DATEADD(DAY, -2, ActivatedAt) WHERE TenantId = @TenantId AND RequestStepId = @S', { S: s1.RequestStepId });
    await runSweep({ tenantId: t.tenantId });
    expect(await mails('Reminder', 'dee@bs.test')).toEqual([]);

    const tuesday = new Date(2026, 9, 6, 9, 0, 0);
    expect(await runDailySummaries({ now: new Date(2026, 9, 6, 6, 0, 0), tenantId: t.tenantId })).toBe(0); // before 7:00
    expect(await runDailySummaries({ now: new Date(2026, 9, 10, 9, 0, 0), tenantId: t.tenantId })).toBe(0); // Saturday
    expect(await runDailySummaries({ now: tuesday, tenantId: t.tenantId })).toBe(1);
    expect(await runDailySummaries({ now: tuesday, tenantId: t.tenantId })).toBe(0); // once a day

    const [summary] = await mails('DailySummary', 'dee@bs.test');
    expect(summary.Subject).toMatch(/^2 requests waiting for your approval/);
    expect(summary.BodyHtml).toContain('Leave');
    expect(summary.BodyHtml).toContain(`/approvals/${s1.RequestStepId}`);
    expect(r2).toBeGreaterThan(r1);

    // an administrator's "Send reminder" still reaches them straight away
    expect((await request(app).post(`${api}/admin/requests/${r1}/remind`).set(bearer(tok.admin))).status).toBe(204);
    expect((await mails('Reminder', 'dee@bs.test')).length).toBe(1);

    // switched back: per-request emails again
    await request(app).put(`${api}/my/preferences`).set(bearer(tok.dee)).send({ emailDigest: false });
    await submit(form, 'Another');
    expect((await mails('ApprovalRequested', 'dee@bs.test')).length).toBe(1);
  });
it('comes at the hour each person chose, in their own time zone', async () => {
    const eve = await makeUser(t.tenantId, 'eve@bs.test', ['Approver'], 'EVE');
    const eveTok = (await login(t.slug, 'eve@bs.test')).body.accessToken;
    const put = (body: Record<string, unknown>) => request(app).put(`${api}/my/preferences`).set(bearer(eveTok)).send(body);
    expect((await put({ emailDigest: true, digestHour: 15, timeZone: 'Not/AZone' })).status).toBe(400);
    const saved = await put({ emailDigest: true, digestHour: 15, timeZone: 'America/Los_Angeles' });
    expect(saved.body).toEqual({ emailDigest: true, digestHour: 15, timeZone: 'America/Los_Angeles' });
    const users = (await request(app).get(`${api}/admin/users`).set(bearer(tok.admin))).body.users;
    expect(users.find((u: { email: string }) => u.email === 'eve@bs.test')).toMatchObject({ emailDigest: true, digestHour: 15, digestTimeZone: 'America/Los_Angeles' });

    await tenantQuery(t.tenantId, 'UPDATE Users SET LastDigestOn = NULL WHERE TenantId = @TenantId AND UserId = @U', { U: eve });
    const form = (await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Cover', slug: 'cover', fields: [{ key: 'title', label: 'Title', type: 'text' }, { key: 'amount', label: 'Amount', type: 'currency' }] })).body.formId;
    await request(app).put(`${api}/admin/forms/${form}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Cover', approverUserId: eve }] });
    await submit(form, 'Cover for Tom');

    // Wednesday 7 October 2026: 22:30 UTC is 15:30 in Los Angeles (PDT, UTC-7); 21:30 UTC is 14:30 there
    expect(await runDailySummaries({ now: new Date(Date.UTC(2026, 9, 7, 21, 30)), tenantId: t.tenantId })).toBe(0);
    expect(await runDailySummaries({ now: new Date(Date.UTC(2026, 9, 7, 22, 30)), tenantId: t.tenantId })).toBe(1);
    expect((await mails('DailySummary', 'eve@bs.test')).length).toBe(1);
    // Friday 23:30 in Los Angeles is already Saturday in UTC - still Friday for her, so it is sent
    expect(await runDailySummaries({ now: new Date(Date.UTC(2026, 9, 10, 6, 30)), tenantId: t.tenantId })).toBe(1);
  });
});
