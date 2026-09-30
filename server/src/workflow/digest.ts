// The daily summary: one email each weekday morning for approvers who chose it (Users.EmailDigest) instead of an
// email per request. It lists everything waiting for them; nothing is sent when nothing is waiting. Run by the
// sweeper every few minutes: from DIGEST_HOUR (server time) on a weekday, each such person is handled once that day -
// Users.LastDigestOn is claimed first, so overlapping runs never send two.
import { config } from '../config';
import { tenantQuery, unscopedQuery, withTx } from '../db/query';
import { emailBody, queueNotification } from '../notifications/outbox';
import { tenantBaseUrlById } from '../tenant';
import { pendingApprovals } from './read';

/** The server-local calendar date, as 2026-09-30. */
const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const waited = (from: Date, now: Date) => {
  const hours = Math.floor((now.getTime() - from.getTime()) / 3_600_000);
  if (hours < 24) return hours < 1 ? 'less than an hour' : `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
};

/** Sends the summaries that are due. `now` is for tests. Returns how many were queued. */
export async function runDailySummaries(opts: { now?: Date; tenantId?: number } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  if (now.getDay() === 0 || now.getDay() === 6 || now.getHours() < config.mail.digestHour) return 0;
  const today = localDay(now);
  const due = await unscopedQuery<{ TenantId: number; UserId: number }>(
    `SELECT u.TenantId, u.UserId
       FROM Users u JOIN Tenants t ON t.TenantId = u.TenantId AND t.IsActive = 1 AND t.RemovedAt IS NULL
      WHERE u.EmailDigest = 1 AND u.IsActive = 1 AND (u.LastDigestOn IS NULL OR u.LastDigestOn < @Today)
        AND (@Tenant IS NULL OR u.TenantId = @Tenant)`,
    { Today: today, Tenant: opts.tenantId ?? null },
  );
  let sent = 0;
  for (const u of due) {
    try {
      if (await summaryFor(u.TenantId, u.UserId, today, now)) sent++;
    } catch (err) {
      if (!config.isTest) console.warn(`[summary] skipped user ${u.UserId}: ${(err as Error).message}`);
    }
  }
  return sent;
}

async function summaryFor(tenantId: number, userId: number, today: string, now: Date): Promise<boolean> {
  return withTx(async (tx) => {
    const [claimed] = await tenantQuery<{ Email: string; DisplayName: string }>(
      tenantId,
      `UPDATE Users SET LastDigestOn = @Today
         OUTPUT inserted.Email, inserted.DisplayName
        WHERE TenantId = @TenantId AND UserId = @UserId AND EmailDigest = 1 AND IsActive = 1 AND (LastDigestOn IS NULL OR LastDigestOn < @Today)`,
      { UserId: userId, Today: today },
      tx,
    );
    if (!claimed) return false; // another run got there first, or they changed their mind
    const waiting = await pendingApprovals(tenantId, userId, tx);
    if (!waiting.length) return false;

    const base = await tenantBaseUrlById(tenantId);
    const overdue = waiting.filter((w) => w.overdue).length;
    await queueNotification(
      tenantId,
      {
        type: 'DailySummary',
        to: { userId, email: claimed.Email },
        subject: `${waiting.length} request${waiting.length === 1 ? '' : 's'} waiting for your approval${overdue ? ` (${overdue} overdue)` : ''}`,
        bodyHtml: emailBody([
          `Hello ${claimed.DisplayName},`,
          `You have ${waiting.length} request${waiting.length === 1 ? '' : 's'} waiting for your approval${overdue ? `, ${overdue} of them overdue` : ''}:`,
          {
            details: waiting.map((w) => ({
              label: `${w.requestNumber} - ${w.formName}`,
              value: `From ${w.submitterName} · step ${w.stepOrder} of ${w.totalSteps} (${w.stepName}) · waiting ${waited(w.activatedAt, now)}${w.overdue ? ' · OVERDUE' : ''}`,
              link: `${base}/approvals/${w.requestStepId}`,
            })),
          },
          { buttons: [{ link: `${base}/`, text: 'Open my approvals', tone: 'ok' }] },
          'You get this summary because you chose one email each morning instead of one per request. You can change that under your name, at the top right of the app.',
        ]),
      },
      tx,
    );
    return true;
  });
}
