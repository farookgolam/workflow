import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

const admin = (method: 'get' | 'post' | 'put' | 'patch', url: string) => request(app)[method](`${api}/admin${url}`).set(bearer(tok.admin));
const decide = (as: string, id: number, body: Record<string, unknown>) => request(app).post(`${api}/approvals/${id}/decision`).set(bearer(tok[as])).send(body);

async function submit(title: string, as = 'sam') {
  const res = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok[as])).send({ values: { title } });
  const steps = await tenantQuery<{ RequestStepId: number }>(t.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R ORDER BY StepOrder', { R: res.body.requestId });
  return { requestId: res.body.requestId as number, steps: steps.map((s) => s.RequestStepId) };
}
async function latestToken(requestStepId: number, email: string) {
  const [m] = await tenantQuery<{ BodyHtml: string }>(
    t.tenantId, 'SELECT TOP 1 BodyHtml FROM Notifications WHERE TenantId = @TenantId AND RequestStepId = @S AND RecipientEmail = @E ORDER BY NotificationId DESC', { S: requestStepId, E: email });
  return /token=([\w-]+)/.exec(m.BodyHtml)![1];
}
const resolve = (as: string, token: string) => request(app).get(`${api}/approvals/resolve?token=${token}`).set(bearer(tok[as]));

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], sue: ['Submitter'], ann: ['Approver'], bob: ['Approver'], cat: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@ad.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@ad.test`)).body.accessToken;
  }
  formId = (await admin('post', '/forms').send({ name: 'Leave', slug: 'leave', fields: [{ key: 'title', label: 'Title', type: 'text', required: true }] })).body.formId;
  await admin('put', `/forms/${formId}/chain`).send({ steps: [{ name: 'Manager', approverUserId: ids.ann, reminderAfterDays: 2 }, { name: 'HR', approverUserId: ids.bob }] });
});
afterAll(closePool);

describe('dashboard and request list', () => {
  it('counts by status incl. Overdue, and reports average time per step', async () => {
    const a = await submit('Alpha holiday');
    const b = await submit('Beta conference', 'sue');
    const c = await submit('Gamma offsite');
    await decide('ann', b.steps[0], { decision: 'reject', rejectionReason: 'Too busy' });
    await decide('ann', c.steps[0], { decision: 'approve' });
    await decide('bob', c.steps[1], { decision: 'approve' });
    // make A overdue
    await tenantQuery(t.tenantId, 'UPDATE RequestSteps SET DueAt = DATEADD(DAY, -1, SYSUTCDATETIME()) WHERE TenantId = @TenantId AND RequestStepId = @S', { S: a.steps[0] });

    const dash = (await admin('get', '/dashboard')).body;
    expect(dash.counts).toEqual({ inProgress: 1, approved: 1, rejected: 1, cancelled: 0, overdue: 1 });
    expect(dash.averageTimePerStep.map((s: { stepName: string; decisions: number }) => [s.stepName, s.decisions])).toEqual([['Manager', 2], ['HR', 1]]);

    const list = async (qs: string) => (await admin('get', `/requests?${qs}`)).body.requests.map((r: { requestId: number }) => r.requestId);
    expect(await list('')).toEqual([c.requestId, b.requestId, a.requestId]);
    expect(await list('status=Overdue')).toEqual([a.requestId]);
    expect((await admin('get', '/requests?status=PendingUpload')).status).toBe(400); // no such view any more
    expect(await list('status=Rejected')).toEqual([b.requestId]);
    expect(await list(`submitter=${ids.sue}`)).toEqual([b.requestId]);
    expect(await list(`approver=${ids.bob}`)).toEqual([c.requestId, b.requestId, a.requestId]); // assigned on every chain
    expect(await list('q=gamma')).toEqual([c.requestId]); // searches submitted data
    expect(await list('q=SUE')).toEqual([b.requestId]); // and submitter
    expect(await list('q=100%25')).toEqual([]); // wildcard characters are literals
    expect(await list('from=2999-01-01')).toEqual([]);
    expect(await list(`formId=${formId}&pageSize=1&page=2`)).toEqual([b.requestId]);
    expect((await admin('get', '/requests?status=Nonsense')).status).toBe(400);
  });

  it('request detail shows the full timeline: steps, entered data, audit trail and emails', async () => {
    const { requestId, steps } = await submit('Delta timeline');
    await decide('ann', steps[0], { decision: 'approve', comments: 'ok' });
    const d = (await admin('get', `/requests/${requestId}`)).body;
    expect(d.request.steps.map((s: { status: string }) => s.status)).toEqual(['Approved', 'Active']);
    expect(d.request.steps[0]).toMatchObject({ actedBy: 'ANN', comments: 'ok' });
    expect(d.audit.map((a: { action: string }) => a.action)).toEqual(['request.submitted', 'step.activated', 'step.approved', 'step.activated']);
    expect(d.notifications.map((n: { type: string }) => n.type)).toEqual(['SubmissionReceived', 'ApprovalRequested', 'ApprovalRequested']);
    expect((await request(app).get(`${api}/admin/requests/${requestId}`).set(bearer(tok.sam))).status).toBe(403);
  });
});

describe('admin actions', () => {
  it('reassign: new approver gets a working link, the old link dies, the old approver can no longer act', async () => {
    const { requestId, steps } = await submit('Reassign me');
    const oldToken = await latestToken(steps[0], 'ann@ad.test');

    expect((await admin('post', `/requests/${requestId}/reassign`).send({ requestStepId: steps[0], newUserId: ids.sam })).body.error.code).toBe('not_an_approver');
    expect((await admin('post', `/requests/${requestId}/reassign`).send({ requestStepId: steps[0], newUserId: ids.cat })).status).toBe(204);

    expect((await resolve('ann', oldToken)).status).toBe(403);
    expect((await resolve('cat', await latestToken(steps[0], 'cat@ad.test'))).body).toEqual({ requestStepId: steps[0] });
    expect((await decide('ann', steps[0], { decision: 'approve' })).status).toBe(404);
    expect((await decide('cat', steps[0], { decision: 'approve' })).status).toBe(200);

    // completed steps can never be reassigned
    expect((await admin('post', `/requests/${requestId}/reassign`).send({ requestStepId: steps[0], newUserId: ids.ann })).status).toBe(409);
  });

  it('delegate: both the approver and the delegate can act; the decision records who did', async () => {
    const { requestId, steps } = await submit('Delegate me');
    expect((await admin('post', `/requests/${requestId}/reassign`).send({ requestStepId: steps[0], newUserId: ids.cat, asDelegate: true })).status).toBe(204);
    expect((await resolve('ann', await latestToken(steps[0], 'ann@ad.test'))).status).toBe(200); // original link still valid
    expect((await decide('cat', steps[0], { decision: 'approve' })).status).toBe(200);
    const d = (await admin('get', `/requests/${requestId}`)).body;
    expect(d.request.steps[0]).toMatchObject({ assignedTo: 'ANN', actedBy: 'CAT' });
    expect(d.audit.find((a: { action: string }) => a.action === 'step.approved').detail.asDelegate).toBe(true);
  });

  it('remind: sends a fresh link to the current approver and counts the reminder', async () => {
    const { requestId, steps } = await submit('Remind me');
    const first = await latestToken(steps[0], 'ann@ad.test');
    expect((await admin('post', `/requests/${requestId}/remind`)).status).toBe(204);
    const second = await latestToken(steps[0], 'ann@ad.test');
    expect(second).not.toBe(first);
    expect((await resolve('ann', first)).status).toBe(403); // superseded
    expect((await resolve('ann', second)).status).toBe(200);
    const [s] = await tenantQuery<{ ReminderCount: number }>(t.tenantId, 'SELECT ReminderCount FROM RequestSteps WHERE TenantId = @TenantId AND RequestStepId = @S', { S: steps[0] });
    expect(s.ReminderCount).toBe(1);

    await admin('post', `/requests/${requestId}/cancel`).send({ reason: 'no longer needed' });
    expect((await admin('post', `/requests/${requestId}/remind`)).status).toBe(409);
  });
});

describe('configuration', () => {
  it('form details, fields (retire, not delete) and chain round-trip through the editor endpoints', async () => {
    expect((await admin('patch', `/forms/${formId}`).send({ description: 'Time off', submittersSeeComments: true })).status).toBe(204);
    const put = await admin('put', `/forms/${formId}/fields`).send({
      fields: [{ key: 'days', label: 'Days', type: 'number', required: true, rules: { min: 1 } }, { key: 'title', label: 'Reason', type: 'text', required: true }],
    });
    expect(put.status).toBe(204);
    const f = (await admin('get', `/forms/${formId}`)).body;
    expect(f.form).toMatchObject({ description: 'Time off', submittersSeeComments: true, isActive: true });
    expect(f.fields.map((x: { key: string; label: string }) => [x.key, x.label])).toEqual([['days', 'Days'], ['title', 'Reason']]);
    expect(f.steps.map((s: { name: string; approverUserId: number }) => [s.name, s.approverUserId])).toEqual([['Manager', ids.ann], ['HR', ids.bob]]);

    // dropping a field retires it; old requests keep their data
    await admin('put', `/forms/${formId}/fields`).send({ fields: [{ key: 'title', label: 'Reason', type: 'text', required: true }] });
    expect((await admin('get', `/forms/${formId}`)).body.fields).toHaveLength(1);
    const [kept] = await tenantQuery<{ n: number }>(t.tenantId, `SELECT COUNT(*) AS n FROM FormFields WHERE TenantId = @TenantId AND FormId = @F AND FieldKey = 'days' AND IsActive = 0`, { F: formId });
    expect(kept.n).toBe(1);

    // deactivated forms disappear for submitters
    await admin('patch', `/forms/${formId}`).send({ isActive: false });
    expect((await request(app).get(`${api}/forms`).set(bearer(tok.sam))).body.forms).toEqual([]);
    await admin('patch', `/forms/${formId}`).send({ isActive: true });

    const listed = (await admin('get', '/forms')).body.forms;
    expect(listed).toEqual([expect.objectContaining({ formId, steps: 2, chainVersion: 1 })]);
  });

  it('user management: edit roles, deactivate (with stranded-approval warning), no self-lockout', async () => {
    await submit('Stranded');
    const off = await admin('patch', `/users/${ids.ann}`).send({ isActive: false });
    expect(off.status).toBe(200);
    expect(off.body.pendingApprovals).toBeGreaterThan(0);
    expect((await login(t.slug, 'ann@ad.test')).status).toBe(401);
    await admin('patch', `/users/${ids.ann}`).send({ isActive: true });

    await admin('patch', `/users/${ids.sue}`).send({ roles: ['Submitter', 'Approver'], displayName: 'Sue Both' });
    const sue = (await admin('get', '/users')).body.users.find((u: { userId: number }) => u.userId === ids.sue);
    expect(sue).toMatchObject({ displayName: 'Sue Both', roles: expect.arrayContaining(['Approver', 'Submitter']) });

    expect((await admin('patch', `/users/${ids.admin}`).send({ isActive: false })).body.error.code).toBe('self_lockout');
    expect((await admin('patch', `/users/${ids.admin}`).send({ roles: ['Approver'] })).body.error.code).toBe('self_lockout');
    expect((await admin('post', `/users/${ids.sue}/send-password-link`)).status).toBe(404); // removed: no emailed password links

    const other = await makeTenant();
    const outsider = await makeUser(other.tenantId, 'x@other.test', ['Submitter']);
    expect((await admin('patch', `/users/${outsider}`).send({ displayName: 'Hacked' })).status).toBe(404);
  });
});

describe('audit log', () => {
  it('is filterable, tenant-scoped and exports to CSV safely', async () => {
    const page = (await admin('get', '/audit?action=step.re&pageSize=5')).body;
    expect(page.total).toBeGreaterThanOrEqual(2);
    expect(page.entries.every((e: { action: string }) => e.action.startsWith('step.re'))).toBe(true);

    await submit('=HYPERLINK("http://evil","x")'); // lands in nobody's audit detail, but usernames/UA could carry formulas too
    const csv = await admin('get', '/audit/export.csv?action=request.submitted');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0]).toContain('AuditId,OccurredAtUtc,Action');
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.slice(1).every((l) => l.includes(',request.submitted,'))).toBe(true);
    expect(csv.text).toContain('""requestNumber""'); // JSON detail is quoted, quotes doubled

    // another tenant's admin sees none of it
    const other = await makeTenant();
    await makeUser(other.tenantId, 'root@elsewhere.test', ['Admin']);
    const otherTok = (await login(other.slug, 'root@elsewhere.test')).body.accessToken;
    const theirs = (await request(app).get(`${api}/admin/audit?action=request.submitted`).set(bearer(otherTok))).body;
    expect(theirs.total).toBe(0);
    // the export itself is audited
    expect((await admin('get', '/audit?action=audit.exported')).body.total).toBe(1);
  });
});
