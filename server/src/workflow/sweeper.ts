// Reminder / escalation sweeper. Rules live on each chain step (configured per form in the admin portal):
//   ReminderAfterDays   - first reminder N days after the step became active
//   ReminderRepeatDays  - then every N days (omit for a single reminder)
//   EscalateAfterDays   - one escalation notice to EscalateToUserId, or the tenant's administrators
// Escalation only notifies - it never reassigns; an administrator decides what to do.
import { audit, systemActor } from '../audit/audit';
import { tenantQuery, unscopedQuery, withTx } from '../db/query';
import { tenantBaseUrlById } from '../tenant';
import { adminRecipients, emailBody, queueNotification } from '../notifications/outbox';
import { config } from '../config';
import { runDailySummaries } from './digest';
import { remindStep } from './engine';

const MAX_REMINDERS = 10; // stop nagging eventually; the request stays Overdue on the dashboard

interface Due { TenantId: number; RequestStepId: number }

export async function runSweep(opts: { tenantId?: number } = {}): Promise<{ reminded: number; escalated: number }> {
  const tenant = opts.tenantId ?? null;
  const base = `FROM RequestSteps rs
       JOIN Requests r ON r.TenantId = rs.TenantId AND r.RequestId = rs.RequestId AND r.Status = 'InProgress'
       JOIN ApprovalSteps s ON s.TenantId = rs.TenantId AND s.StepId = rs.StepId
      WHERE rs.Status = 'Active' AND (@Tenant IS NULL OR rs.TenantId = @Tenant)`;

  const reminders = await unscopedQuery<Due>(
    `SELECT TOP 200 rs.TenantId, rs.RequestStepId ${base}
        AND rs.ReminderCount < @Max
        AND ((rs.ReminderCount = 0 AND s.ReminderAfterDays IS NOT NULL AND DATEADD(DAY, s.ReminderAfterDays, rs.ActivatedAt) <= SYSUTCDATETIME())
          OR (rs.ReminderCount > 0 AND s.ReminderRepeatDays IS NOT NULL AND DATEADD(DAY, s.ReminderRepeatDays, rs.LastReminderAt) <= SYSUTCDATETIME()))`,
    { Tenant: tenant, Max: MAX_REMINDERS },
  );
  let reminded = 0;
  for (const d of reminders) {
    try {
      await remindStep(d.TenantId, systemActor, d.RequestStepId, 'scheduled');
      reminded++;
    } catch (err) {
      // e.g. decided a moment ago - not an error worth stopping the sweep for
      if (!config.isTest) console.warn(`[sweeper] reminder skipped for step ${d.RequestStepId}: ${(err as Error).message}`);
    }
  }

  const escalations = await unscopedQuery<Due>(
    `SELECT TOP 200 rs.TenantId, rs.RequestStepId ${base}
        AND rs.EscalatedAt IS NULL AND s.EscalateAfterDays IS NOT NULL
        AND DATEADD(DAY, s.EscalateAfterDays, rs.ActivatedAt) <= SYSUTCDATETIME()`,
    { Tenant: tenant },
  );
  let escalated = 0;
  for (const d of escalations) if (await escalateStep(d.TenantId, d.RequestStepId)) escalated++;
  return { reminded, escalated };
}

async function escalateStep(tenantId: number, requestStepId: number): Promise<boolean> {
  return withTx(async (tx) => {
    // claim first: EscalatedAt doubles as the "already handled" marker, so overlapping sweeps escalate once
    const [{ n }] = await tenantQuery<{ n: number }>(
      tenantId,
      `UPDATE RequestSteps SET EscalatedAt = SYSUTCDATETIME()
        WHERE TenantId = @TenantId AND RequestStepId = @S AND Status = 'Active' AND EscalatedAt IS NULL;
       SELECT @@ROWCOUNT AS n;`,
      { S: requestStepId },
      tx,
    );
    if (n !== 1) return false;

    const [row] = await tenantQuery<Record<string, any>>(
      tenantId,
      `SELECT r.RequestId, r.RequestNumber, f.Name AS FormName, t.Slug, rs.StepOrder, rs.StepName, rs.ActivatedAt, r.TotalSteps,
              au.DisplayName AS Approver, su.DisplayName AS Submitter, s.EscalateAfterDays, eu.UserId AS EscUserId, eu.Email AS EscEmail, eu.IsActive AS EscActive
         FROM RequestSteps rs
         JOIN Requests r ON r.TenantId = rs.TenantId AND r.RequestId = rs.RequestId
         JOIN Forms f ON f.TenantId = r.TenantId AND f.FormId = r.FormId
         JOIN Tenants t ON t.TenantId = r.TenantId
         JOIN ApprovalSteps s ON s.TenantId = rs.TenantId AND s.StepId = rs.StepId
         JOIN Users au ON au.TenantId = rs.TenantId AND au.UserId = rs.AssignedUserId
         JOIN Users su ON su.TenantId = r.TenantId AND su.UserId = r.SubmitterUserId
         LEFT JOIN Users eu ON eu.TenantId = s.TenantId AND eu.UserId = s.EscalateToUserId
        WHERE rs.TenantId = @TenantId AND rs.RequestStepId = @S`,
      { S: requestStepId },
      tx,
    );
    const recipients = row.EscUserId && row.EscActive ? [{ userId: row.EscUserId as number, email: row.EscEmail as string }] : await adminRecipients(tenantId, tx);
    for (const to of recipients) {
      await queueNotification(
        tenantId,
        {
          type: 'Escalation',
          to,
          subject: `Escalation: ${row.FormName} ${row.RequestNumber} has waited ${row.EscalateAfterDays} day(s)`,
          bodyHtml: emailBody([
            `A request has been waiting for a decision for more than ${row.EscalateAfterDays} day(s).`,
            { label: 'Request', value: `${row.FormName} ${row.RequestNumber}` },
            { label: 'Submitted by', value: row.Submitter },
            { label: 'Waiting at', value: `Step ${row.StepOrder} of ${row.TotalSteps} - ${row.StepName}` },
            { label: 'Approver', value: row.Approver },
            { label: 'Waiting since', value: `${(row.ActivatedAt as Date).toISOString().slice(0, 16).replace('T', ' ')} UTC` },
            { link: `${await tenantBaseUrlById(tenantId)}/admin/requests/${row.RequestId}`, text: 'Open in the administrator portal' },
            'An administrator can send a reminder, reassign the step or add a delegate from that page.',
          ]),
          requestId: row.RequestId,
          requestStepId,
        },
        tx,
      );
    }
    await audit(tenantId, systemActor, { action: 'step.escalated', entityType: 'RequestStep', entityId: requestStepId, requestId: row.RequestId, detail: { stepOrder: row.StepOrder, afterDays: row.EscalateAfterDays, notified: recipients.map((r) => r.email) } }, tx);
    return true;
  });
}

export function startSweeper(intervalMs = 5 * 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runSweep();
      if (r.reminded || r.escalated) console.log(`[sweeper] ${r.reminded} reminder(s), ${r.escalated} escalation(s)`);
      const summaries = await runDailySummaries();
      if (summaries) console.log(`[sweeper] ${summaries} daily summary email(s)`);
    } catch (err) {
      console.error('[sweeper]', (err as Error).message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  console.log('Reminder/escalation/daily-summary sweeper started');
  return () => clearInterval(timer);
}
