import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { runSweep } from '../src/workflow/sweeper';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

async function submit() {
  const res = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { title: 'x' } });
  const [s] = await tenantQuery<{ RequestStepId: number }>(t.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R AND StepOrder = 1', { R: res.body.requestId });
  return { requestId: res.body.requestId as number, stepId: s.RequestStepId };
}
/** Moves the step's clock back by `days` more days (plus a minute, to stay clear of clock-tick boundaries). */
const age = (stepId: number, days: number) =>
  tenantQuery(t.tenantId, 'UPDATE RequestSteps SET ActivatedAt = DATEADD(MINUTE, -1, DATEADD(DAY, -@D, ActivatedAt)), LastReminderAt = DATEADD(MINUTE, -1, DATEADD(DAY, -@D, LastReminderAt)) WHERE TenantId = @TenantId AND RequestStepId = @S', { D: days, S: stepId });
const mails = async (requestId: number) =>
  (await tenantQuery<{ Type: string; RecipientEmail: string }>(t.tenantId, 'SELECT Type, RecipientEmail FROM Notifications WHERE TenantId = @TenantId AND RequestId = @R ORDER BY NotificationId', { R: requestId }))
    .map((m) => `${m.Type}>${m.RecipientEmail.split('@')[0]}`).filter((m) => /Reminder|Escalation/.test(m));
const sweep = () => runSweep({ tenantId: t.tenantId });

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], boss: ['Approver'], sam: ['Submitter'], ann: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@sw.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@sw.test`)).body.accessToken;
  }
  formId = (await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Sweep', slug: 'sweep', fields: [{ key: 'title', label: 'T', type: 'text', required: true }] })).body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({
    steps: [{ name: 'Manager', approverUserId: ids.ann, reminderAfterDays: 3, reminderRepeatDays: 2, escalateAfterDays: 7, escalateToUserId: ids.boss }],
  });
});
afterAll(closePool);

describe('reminders and escalation', () => {
  it('reminds after X days, repeats on the repeat interval, escalates once, and stops when the step is decided', async () => {
    const { requestId, stepId } = await submit();

    expect(await sweep()).toEqual({ reminded: 0, escalated: 0 }); // fresh: nothing due

    await age(stepId, 3);
    expect(await sweep()).toEqual({ reminded: 1, escalated: 0 });
    expect(await sweep()).toEqual({ reminded: 0, escalated: 0 }); // not again until the repeat interval passes
    expect(await mails(requestId)).toEqual(['Reminder>ann']);

    await age(stepId, 2); // 5 days active, last reminder 2 days ago
    expect(await sweep()).toEqual({ reminded: 1, escalated: 0 });

    await age(stepId, 2); // 7 days: repeat reminder + escalation to the named user
    expect(await sweep()).toEqual({ reminded: 1, escalated: 1 });
    expect(await mails(requestId)).toEqual(['Reminder>ann', 'Reminder>ann', 'Reminder>ann', 'Escalation>boss']);

    await age(stepId, 5);
    expect(await sweep()).toEqual({ reminded: 1, escalated: 0 }); // reminders keep repeating; escalation happens once

    // the reminder link works, and deciding ends the nagging
    const [m] = await tenantQuery<{ BodyHtml: string }>(t.tenantId, `SELECT TOP 1 BodyHtml FROM Notifications WHERE TenantId = @TenantId AND RequestId = @R AND Type = 'Reminder' ORDER BY NotificationId DESC`, { R: requestId });
    const token = /token=([\w-]+)/.exec(m.BodyHtml)![1];
    expect((await request(app).post(`${api}/approvals/${stepId}/decision`).set(bearer(tok.ann)).send({ decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] }, token })).status).toBe(200);
    await age(stepId, 30).catch(() => {}); // completed steps are immutable - the trigger refuses, which is fine
    expect(await sweep()).toEqual({ reminded: 0, escalated: 0 });

    const actions = (await tenantQuery<{ Action: string; UserId: number | null }>(t.tenantId, `SELECT Action, UserId FROM AuditLog WHERE TenantId = @TenantId AND RequestId = @R AND Action IN ('step.reminder_sent','step.escalated')`, { R: requestId }));
    expect(actions.map((a) => a.Action).sort()).toEqual(['step.escalated', 'step.reminder_sent', 'step.reminder_sent', 'step.reminder_sent', 'step.reminder_sent']);
    expect(actions.every((a) => a.UserId === null)).toBe(true); // recorded as System
  });

  it('falls back to the administrators when no escalation user is set, and ignores closed requests', async () => {
    await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Manager', approverUserId: ids.ann, escalateAfterDays: 1 }] });
    const a = await submit();
    const b = await submit();
    await request(app).post(`${api}/admin/requests/${b.requestId}/cancel`).set(bearer(tok.admin)).send({ reason: 'n/a' });
    await age(a.stepId, 2);
    expect(await sweep()).toEqual({ reminded: 0, escalated: 1 });
    expect(await mails(a.requestId)).toEqual(['Escalation>admin']);
    expect(await mails(b.requestId)).toEqual([]);
  });
});
