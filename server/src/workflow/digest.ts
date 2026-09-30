// The daily summary: one email each weekday for approvers who chose it (Users.EmailDigest) instead of an email per
// request. It lists everything waiting for them; nothing is sent when nothing is waiting. Run by the sweeper every few
// minutes: from each person's chosen hour (Users.DigestHour, else DIGEST_HOUR) on a weekday, in their own time zone
// (Users.DigestTimeZone, else server time), each is handled once that day - Users.LastDigestOn, that zone's date, is
// claimed first, so overlapping runs never send two.
import { config } from '../config';
import { tenantQuery, unscopedQuery, withTx } from '../db/query';
import { emailBody, queueNotification } from '../notifications/outbox';
import { tenantBaseUrlById } from '../tenant';
import { pendingApprovals } from './read';

const two = (n: number) => String(n).padStart(2, '0');
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Weekday (0 = Sunday), hour and calendar date (2026-09-30) of `now` in a time zone - server time when none or unknown. */
export function userClock(now: Date, timeZone: string | null): { day: number; hour: number; date: string } {
  if (timeZone) {
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
        .formatToParts(now).map((x) => [x.type, x.value]));
      return { day: WEEKDAY[p.weekday], hour: Number(p.hour), date: `${p.year}-${p.month}-${p.day}` };
    } catch { /* not a zone this server knows: server time */ }
  }
  return { day: now.getDay(), hour: now.getHours(), date: `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}` };
}

/** Whether a zone name is one this server can work with. */
export const knownTimeZone = (tz: string): boolean => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

const waited = (from: Date, now: Date) => {
  const hours = Math.floor((now.getTime() - from.getTime()) / 3_600_000);
  if (hours < 24) return hours < 1 ? 'less than an hour' : `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
};

/** Sends the summaries that are due. `now` is for tests. Returns how many were queued. */
export async function runDailySummaries(opts: { now?: Date; tenantId?: number } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const people = await unscopedQuery<{ TenantId: number; UserId: number; DigestHour: number | null; DigestTimeZone: string | null }>(
    `SELECT u.TenantId, u.UserId, u.DigestHour, u.DigestTimeZone
       FROM Users u JOIN Tenants t ON t.TenantId = u.TenantId AND t.IsActive = 1 AND t.RemovedAt IS NULL
      WHERE u.EmailDigest = 1 AND u.IsActive = 1 AND (@Tenant IS NULL OR u.TenantId = @Tenant)`,
    { Tenant: opts.tenantId ?? null },
  );
  let sent = 0;
  for (const u of people) {
    const c = userClock(now, u.DigestTimeZone);
    if (c.day === 0 || c.day === 6 || c.hour < (u.DigestHour ?? config.mail.digestHour)) continue;
    try {
      if (await summaryFor(u.TenantId, u.UserId, c.date, now)) sent++;
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
          'You get this summary because you chose one email a day instead of one per request. You can change that, or its time, under your name at the top right of the app.',
        ]),
      },
      tx,
    );
    return true;
  });
}
