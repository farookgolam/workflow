import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { audit, systemActor } from '../audit/audit';
import { config } from '../config';
import { unscopedQuery } from '../db/query';
import { effectiveSettings } from '../settings/service';

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Which customer this belongs to: it decides the sender address and, in file mode, the folder. */
  tenantId: number;
  from: string;
}
export interface MailTransport {
  send(mail: OutgoingMail): Promise<void>;
}

/** Real SMTP when SMTP_HOST is set; otherwise each email is written to STORAGE_DIR/mail/*.eml (open with any mail client). */
export function createTransport(): MailTransport {
  if (config.mail.host) {
    const smtp = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.password ?? '' } : undefined,
    });
    return { send: async ({ tenantId: _tenantId, ...m }) => void (await smtp.sendMail(m)) };
  }
  const root = path.join(config.storageDir, 'mail');
  const file = nodemailer.createTransport({ streamTransport: true, buffer: true });
  return {
    send: async ({ tenantId, ...m }) => {
      const info = await file.sendMail(m);
      // one folder per customer, so a dry-run mailbox is never a mix of two organisations
      const dir = path.join(root, `tenant-${tenantId}`);
      await fs.promises.mkdir(dir, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}_${m.to.replace(/[^\w.@-]/g, '_')}.eml`;
      await fs.promises.writeFile(path.join(dir, name), info.message as Buffer);
    },
  };
}

const layout = (subject: string, body: string) =>
  `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Segoe UI,Arial,sans-serif;color:#1f2937">
<div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:24px 28px">
<h2 style="margin:0 0 16px;font-size:18px">${subject.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)}</h2>
${body}
<p style="margin-top:24px;font-size:12px;color:#6b7280">This is an automated message from FileBank WorkFlow. Please do not reply.</p>
</div></body></html>`;

const toText = (html: string) =>
  html
    .replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g, '$2: $1')
    .replace(/<\/p>/g, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();

interface Claimed {
  NotificationId: number;
  TenantId: number;
  Type: string;
  RecipientEmail: string;
  Subject: string;
  BodyHtml: string;
  Attempts: number;
}

/**
 * Delivers one batch of queued notifications. Rows are claimed atomically with a 5-minute
 * lease (NextAttemptAt), so overlapping runs - or a crash mid-send - never double-claim and
 * never lose a message. Failures back off, then park as Failed for the admin to resend.
 */
export async function processOutbox(transport: MailTransport, batchSize = 20): Promise<{ sent: number; failed: number }> {
  const claimed = await unscopedQuery<Claimed>(
    `UPDATE TOP (@Batch) Notifications
        SET NextAttemptAt = DATEADD(MINUTE, 5, SYSUTCDATETIME()), Attempts = Attempts + 1
     OUTPUT inserted.NotificationId, inserted.TenantId, inserted.Type, inserted.RecipientEmail, inserted.Subject, inserted.BodyHtml, inserted.Attempts
      WHERE Status = 'Queued' AND (NextAttemptAt IS NULL OR NextAttemptAt <= SYSUTCDATETIME())`,
    { Batch: batchSize },
  );
  let sent = 0;
  let failed = 0;
  for (const n of claimed) {
    try {
      const { mail } = await effectiveSettings(n.TenantId); // this customer's own sender address
      await transport.send({
        tenantId: n.TenantId,
        from: mail.from,
        to: n.RecipientEmail,
        subject: n.Subject,
        html: layout(n.Subject, n.BodyHtml),
        text: toText(n.BodyHtml),
      });
      await unscopedQuery(
        `UPDATE Notifications SET Status = 'Sent', SentAt = SYSUTCDATETIME(), NextAttemptAt = NULL, LastError = NULL WHERE NotificationId = @Id`,
        { Id: n.NotificationId },
      );
      sent++;
    } catch (err) {
      failed++;
      const giveUp = n.Attempts >= config.mail.maxAttempts;
      const delay = config.mail.backoffMinutes[Math.min(n.Attempts - 1, config.mail.backoffMinutes.length - 1)];
      await unscopedQuery(
        `UPDATE Notifications
            SET Status = @Status, LastError = @Error,
                NextAttemptAt = CASE WHEN @Status = 'Failed' THEN NULL ELSE DATEADD(MINUTE, @Delay, SYSUTCDATETIME()) END
          WHERE NotificationId = @Id`,
        { Status: giveUp ? 'Failed' : 'Queued', Error: String((err as Error).message ?? err).slice(0, 2000), Delay: delay, Id: n.NotificationId },
      );
      if (giveUp) {
        await audit(n.TenantId, systemActor, {
          action: 'notification.failed',
          entityType: 'Notification',
          entityId: n.NotificationId,
          detail: { type: n.Type, to: n.RecipientEmail, attempts: n.Attempts },
        });
      }
    }
  }
  return { sent, failed };
}

/** In-process poller. One run at a time; errors are logged and the loop carries on. */
export function startMailWorker(intervalMs = 10_000): () => void {
  const transport = createTransport();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      for (let r = await processOutbox(transport); r.sent + r.failed > 0; r = await processOutbox(transport));
    } catch (err) {
      console.error('[mail-worker]', (err as Error).message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  console.log(`Mail worker started (${config.mail.host ? `SMTP ${config.mail.host}:${config.mail.port}` : `writing .eml files to ${config.storageDir}\\mail`})`);
  return () => clearInterval(timer);
}
