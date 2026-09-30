import { tenantQuery, type Tx } from '../db/query';

export type NotificationType =
  | 'SubmissionReceived'
  | 'ApprovalRequested'
  | 'Reminder'
  | 'Escalation'
  | 'Rejected'
  | 'FinalApproved'
  | 'Cancelled'
  | 'Reassigned'
  | 'SentBack'
  | 'Resubmitted'
  | 'DailySummary'
  | 'AdminRejectedAlert'
  | 'AdminUploadFailed'
  | 'VerificationCode'
  | 'AccountCreated';

export interface Recipient {
  userId: number | null;
  email: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export type EmailLine =
  | string
  | { label: string; value: string }
  | { link: string; text: string }
  /** a row of big buttons, e.g. Approve / Reject */
  | { buttons: { link: string; text: string; tone: 'ok' | 'bad' | 'plain' }[] }
  /** a two-column table of values, e.g. the submitted form; nothing at all when empty */
  | { details: { label: string; value: string; link?: string }[]; title?: string };

const TONE = { ok: '#15803d', bad: '#b91c1c', plain: '#475569' } as const;

/** Tiny HTML builder: every interpolated value is escaped; links are passed separately. */
export function emailBody(lines: EmailLine[]): string {
  return lines
    .map((l) => {
      if (typeof l === 'string') return `<p>${esc(l)}</p>`;
      if ('buttons' in l) {
        return `<p>${l.buttons
          .map((b) => `<a href="${esc(b.link)}" style="display:inline-block;padding:10px 22px;margin:0 8px 8px 0;border-radius:6px;background:${TONE[b.tone]};color:#ffffff;font-weight:bold;text-decoration:none">${esc(b.text)}</a>`)
          .join('')}</p>`;
      }
      if ('details' in l) {
        if (!l.details.length) return '';
        const rows = l.details
          .map((d) => `<tr><td style="padding:4px 16px 4px 0;color:#475569;vertical-align:top">${d.link ? `<a href="${esc(d.link)}">${esc(d.label)}</a>` : esc(d.label)}</td><td style="padding:4px 0;vertical-align:top">${esc(d.value)}</td></tr>`)
          .join('');
        return `${l.title ? `<p><strong>${esc(l.title)}</strong></p>` : ''}<table style="border-collapse:collapse;margin:0 0 12px">${rows}</table>`;
      }
      if ('link' in l) return `<p><a href="${esc(l.link)}">${esc(l.text)}</a></p>`;
      return `<p><strong>${esc(l.label)}:</strong> ${esc(l.value)}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Queues an email in the same transaction as the state change that caused it (transactional
 * outbox). The mail worker delivers Queued rows; nothing here talks to SMTP.
 */
export async function queueNotification(
  tenantId: number,
  n: { type: NotificationType; to: Recipient; subject: string; bodyHtml: string; requestId?: number; requestStepId?: number },
  tx: Tx,
): Promise<void> {
  await tenantQuery(
    tenantId,
    `INSERT INTO Notifications (TenantId, RequestId, RequestStepId, Type, RecipientUserId, RecipientEmail, Subject, BodyHtml)
     VALUES (@TenantId, @RequestId, @RequestStepId, @Type, @UserId, @Email, @Subject, @Body)`,
    {
      RequestId: n.requestId ?? null,
      RequestStepId: n.requestStepId ?? null,
      Type: n.type,
      UserId: n.to.userId,
      Email: n.to.email,
      Subject: n.subject.slice(0, 300),
      Body: n.bodyHtml,
    },
    tx,
  );
}

/** Tenant's AdminNotifyEmail if set, otherwise every active Admin user. */
export async function adminRecipients(tenantId: number, tx: Tx): Promise<Recipient[]> {
  const [t] = await tenantQuery<{ AdminNotifyEmail: string | null }>(
    tenantId,
    'SELECT AdminNotifyEmail FROM Tenants WHERE TenantId = @TenantId',
    {},
    tx,
  );
  if (t?.AdminNotifyEmail) return [{ userId: null, email: t.AdminNotifyEmail }];
  const admins = await tenantQuery<{ UserId: number; Email: string }>(
    tenantId,
    `SELECT u.UserId, u.Email FROM Users u
       JOIN UserRoles r ON r.TenantId = u.TenantId AND r.UserId = u.UserId AND r.Role = 'Admin'
      WHERE u.TenantId = @TenantId AND u.IsActive = 1`,
    {},
    tx,
  );
  return admins.map((a) => ({ userId: a.UserId, email: a.Email }));
}
