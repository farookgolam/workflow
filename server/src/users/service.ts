import { tenantQuery, type Tx } from '../db/query';
import { AppError } from '../http/errors';
import type { Role } from '../auth/middleware';
import { emailBody, queueNotification } from '../notifications/outbox';
import { tenantById, tenantBaseUrl } from '../tenant';

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * "Your account for <organisation>": tells someone an account was made for them and how to sign in (their first
 * sign-in confirms the address with a code and lets them choose a key). `asAdministrator`: a global administrator
 * made them an administrator of the organisation.
 */
export async function queueAccountCreatedEmail(
  tenantId: number, user: { userId: number; email: string; displayName: string }, tx: Tx, opts: { asAdministrator?: boolean } = {},
): Promise<void> {
  const t = await tenantById(tenantId);
  const org = t?.name ?? 'FileBank WorkFlow';
  await queueNotification(tenantId, {
    type: 'AccountCreated',
    to: { userId: user.userId, email: user.email },
    subject: `Your account for ${t?.name ?? 'FileBank WorkFlow'}`,
    bodyHtml: emailBody([
      `Hello ${user.displayName},`,
      opts.asAdministrator ? `You have been given an administrator account for ${org}.` : `An administrator has given you an account for ${org}.`,
      'Sign in with this email address. The first time, you will be emailed a code to confirm it is yours, and then you choose your own 6-digit password key.',
      { buttons: [{ link: `${t ? tenantBaseUrl(t) : ''}/login`, text: 'Sign in', tone: 'ok' }] },
    ]),
  }, tx);
}

/**
 * Inserts a user. `passwordSet: false` creates an account with no password key yet - the owner
 * creates one at first sign-in. Used by self-registration, the seed scripts and tests.
 */
export async function createUser(
  tenantId: number,
  input: { email: string; displayName: string; roles: Role[]; passwordHash: string; passwordSet?: boolean },
  tx: Tx,
): Promise<number> {
  const email = normalizeEmail(input.email);
  const existing = await tenantQuery(
    tenantId,
    'SELECT 1 AS x FROM Users WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND Email = @Email',
    { Email: email },
    tx,
  );
  if (existing.length) throw new AppError(409, 'email_taken', 'A user with this email already exists');

  const [{ UserId }] = await tenantQuery<{ UserId: number }>(
    tenantId,
    `INSERT INTO Users (TenantId, Email, PasswordHash, DisplayName, PasswordSetAt)
     OUTPUT inserted.UserId
     VALUES (@TenantId, @Email, @PasswordHash, @DisplayName, CASE WHEN @PasswordSet = 1 THEN SYSUTCDATETIME() ELSE NULL END)`,
    { Email: email, PasswordHash: input.passwordHash, DisplayName: input.displayName.trim(), PasswordSet: input.passwordSet === false ? 0 : 1 },
    tx,
  );
  for (const role of new Set(input.roles)) {
    await tenantQuery(
      tenantId,
      'INSERT INTO UserRoles (TenantId, UserId, Role) VALUES (@TenantId, @UserId, @Role)',
      { UserId, Role: role },
      tx,
    );
  }
  return UserId;
}
