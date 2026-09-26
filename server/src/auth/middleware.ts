import type { RequestHandler } from 'express';
import { tenantQuery } from '../db/query';
import { AppError } from '../http/errors';
import { verifyAccessToken } from './tokens';

export type Role = 'Admin' | 'Approver' | 'Submitter';

export interface AuthUser {
  userId: number;
  tenantId: number;
  tenantSlug: string;
  email: string;
  displayName: string;
  roles: Role[];
  /** PlatformAdminId when a global administrator is acting as this user; undefined normally. */
  impersonatedBy?: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export async function loadUser(tenantId: number, userId: number): Promise<AuthUser | null> {
  const rows = await tenantQuery<{ Email: string; DisplayName: string; Slug: string; Role: Role | null }>(
    tenantId,
    `SELECT u.Email, u.DisplayName, t.Slug, r.Role
       FROM Users u
       JOIN Tenants t ON t.TenantId = u.TenantId AND t.IsActive = 1
       LEFT JOIN UserRoles r ON r.TenantId = u.TenantId AND r.UserId = u.UserId
      WHERE u.TenantId = @TenantId AND u.UserId = @UserId AND u.IsActive = 1`,
    { UserId: userId },
  );
  if (rows.length === 0) return null;
  return {
    userId,
    tenantId,
    tenantSlug: rows[0].Slug,
    email: rows[0].Email,
    displayName: rows[0].DisplayName,
    roles: rows.map((r) => r.Role).filter((r): r is Role => r !== null),
  };
}

/**
 * Verifies the bearer token, then re-reads the user so deactivation and role changes take
 * effect immediately rather than when the JWT expires. req.user.tenantId is the only
 * tenant id handlers may use - it is never taken from the URL, query or body.
 */
export const requireAuth: RequestHandler = async (req, _res, next) => {
  const header = req.get('authorization') ?? '';
  const claims = header.startsWith('Bearer ') ? verifyAccessToken(header.slice(7)) : null;
  if (!claims) throw new AppError(401, 'unauthenticated', 'Sign in required');
  const user = await loadUser(claims.tenantId, claims.userId);
  if (!user) throw new AppError(401, 'unauthenticated', 'Sign in required');
  req.user = { ...user, impersonatedBy: claims.impersonatedBy };
  next();
};

export function requireRole(...allowed: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) throw new AppError(401, 'unauthenticated', 'Sign in required');
    if (!req.user.roles.some((r) => allowed.includes(r))) {
      throw new AppError(403, 'forbidden', 'You do not have access to this resource');
    }
    next();
  };
}
