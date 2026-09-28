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
  | 'AdminRejectedAlert'
  | 'AdminUploadFailed'
  | 'VerificationCode'
  | 'AccountCreated';

export interface Recipient {
  userId: number | null;
  email: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Tiny HTML builder: every interpolated value is escaped; links are passed separately. */
export function emailBody(lines: (string | { label: string; value: string } | { link: string; text: string })[]): string {
  return lines
    .map((l) => {
      if (typeof l === 'string') return `<p>${esc(l)}</p>`;
      if ('link' in l) return `<p><a href="${esc(l.link)}">${esc(l.text)}</a></p>`;
      return `<p><strong>${esc(l.label)}:</strong> ${esc(l.value)}</p>`;
    })
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
