import type { CookieOptions, Request, Response } from 'express';
import { config } from '../config';
import { tenantQuery, type Tx } from '../db/query';
import { newOpaqueToken } from './tokens';

export const REFRESH_COOKIE = 'af_rt';

export const cookieOptions = (): CookieOptions => ({
  httpOnly: true,
  secure: config.auth.cookieSecure,
  sameSite: 'strict',
  path: '/api/v1/auth',
  maxAge: config.auth.refreshTtlDays * 24 * 60 * 60 * 1000,
});

export async function issueRefreshToken(tenantId: number, userId: number, req: Request, res: Response, tx?: Tx): Promise<void> {
  const { raw, hash } = newOpaqueToken();
  await tenantQuery(
    tenantId,
    `INSERT INTO RefreshTokens (TenantId, UserId, TokenHash, ExpiresAt, CreatedIp)
     VALUES (@TenantId, @UserId, @Hash, DATEADD(DAY, @Days, SYSUTCDATETIME()), @Ip)`,
    { UserId: userId, Hash: hash, Days: config.auth.refreshTtlDays, Ip: req.ip ?? null },
    tx,
  );
  res.cookie(REFRESH_COOKIE, raw, cookieOptions());
}

export const revokeAllRefreshTokens = (tenantId: number, userId: number, tx?: Tx) =>
  tenantQuery(
    tenantId,
    `UPDATE RefreshTokens SET RevokedAt = SYSUTCDATETIME()
      WHERE TenantId = @TenantId AND UserId = @UserId AND RevokedAt IS NULL`,
    { UserId: userId },
    tx,
  );
