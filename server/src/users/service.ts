import { tenantQuery, type Tx } from '../db/query';
import { AppError } from '../http/errors';
import type { Role } from '../auth/middleware';

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

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
