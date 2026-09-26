// Global ("platform") administrators: the people who create and manage customers.
//
// They are NOT rows in Users and carry no TenantId, so no customer administrator can see, deactivate
// or reset one, and no tenant-scoped query can return one. Their session is a separate cookie and a
// separate JWT audience, so a platform token is rejected by the customer API and a customer token is
// rejected here. Everything they do is written to PlatformAuditLog, which is append-only.
import type { CookieOptions, Request, RequestHandler, Response } from 'express';
import { cleanIp } from '../audit/audit';
import { config } from '../config';
import { unscopedQuery, type Tx } from '../db/query';
import { AppError } from '../http/errors';
import { newOpaqueToken, verifyPlatformToken } from '../auth/tokens';

export const PLATFORM_REFRESH_COOKIE = 'af_prt';

export interface PlatformAdmin {
  platformAdminId: number;
  email: string;
  displayName: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    platformAdmin?: PlatformAdmin;
  }
}

export const platformCookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: config.auth.cookieSecure,
  sameSite: 'strict',
  path: '/api/v1/global/auth',
  maxAge: config.auth.refreshTtlDays * 24 * 60 * 60 * 1000,
});

export async function loadPlatformAdmin(platformAdminId: number): Promise<PlatformAdmin | null> {
  const [row] = await unscopedQuery<{ Email: string; DisplayName: string }>(
    'SELECT Email, DisplayName FROM PlatformAdmins WHERE PlatformAdminId = @Id AND IsActive = 1',
    { Id: platformAdminId },
  );
  return row ? { platformAdminId, email: row.Email, displayName: row.DisplayName } : null;
}

/**
 * Verifies the bearer token, then re-reads the administrator so a deactivation takes effect at once.
 * The token audience is 'platform', so a customer's access token can never satisfy this.
 */
export const requirePlatformAdmin: RequestHandler = async (req, _res, next) => {
  const header = req.get('authorization') ?? '';
  const claims = header.startsWith('Bearer ') ? verifyPlatformToken(header.slice(7)) : null;
  if (!claims) throw new AppError(401, 'unauthenticated', 'Sign in required');
  const admin = await loadPlatformAdmin(claims.platformAdminId);
  if (!admin) throw new AppError(401, 'unauthenticated', 'Sign in required');
  req.platformAdmin = admin;
  next();
};

export async function issuePlatformRefreshToken(platformAdminId: number, req: Request, res: Response, tx?: Tx): Promise<void> {
  const { raw, hash } = newOpaqueToken();
  await unscopedQuery(
    `INSERT INTO PlatformRefreshTokens (PlatformAdminId, TokenHash, ExpiresAt, CreatedIp)
     VALUES (@Id, @Hash, DATEADD(DAY, @Days, SYSUTCDATETIME()), @Ip)`,
    { Id: platformAdminId, Hash: hash, Days: config.auth.refreshTtlDays, Ip: req.ip ?? null },
    tx,
  );
  res.cookie(PLATFORM_REFRESH_COOKIE, raw, platformCookieOptions());
}

export const revokeAllPlatformRefreshTokens = (platformAdminId: number, tx?: Tx) =>
  unscopedQuery(
    'UPDATE PlatformRefreshTokens SET RevokedAt = SYSUTCDATETIME() WHERE PlatformAdminId = @Id AND RevokedAt IS NULL',
    { Id: platformAdminId },
    tx,
  );

export interface PlatformAuditEntry {
  action: string; // e.g. platform.login, tenant.created, tenant.suspended
  entityType: string;
  entityId?: number | null;
  tenantId?: number | null;
  detail?: Record<string, unknown>;
}

/**
 * Append-only record of what a global administrator did. Pass the transaction of the change itself.
 * `req` is null for what the system does on its own (the tenant purge job), with no admin id either.
 */
export async function platformAudit(
  req: Request | null,
  platformAdminId: number | null,
  e: PlatformAuditEntry,
  tx?: Tx,
): Promise<void> {
  await unscopedQuery(
    `INSERT INTO PlatformAuditLog (PlatformAdminId, TenantId, IpAddress, UserAgent, Action, EntityType, EntityId, DetailJson)
     VALUES (@AdminId, @TenantId, @Ip, @Ua, @Action, @EntityType, @EntityId, @Detail)`,
    {
      AdminId: platformAdminId,
      TenantId: e.tenantId ?? null,
      Ip: req ? cleanIp(req.ip) : null,
      Ua: (req?.get('user-agent') ?? '').slice(0, 400) || null,
      Action: e.action,
      EntityType: e.entityType,
      EntityId: e.entityId ?? null,
      Detail: e.detail ? JSON.stringify(e.detail) : null,
    },
    tx,
  );
}
