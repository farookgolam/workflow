// Sign-in for the global management site: /api/v1/global/auth/*
// Same defences as the customer sign-in (argon2id key, lock-out after 5 wrong attempts, rotating
// refresh token with reuse detection), on its own tables and its own cookie.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { hashPassword, passwordKeyProblem, unusablePasswordHash, verifyPassword } from '../auth/password';
import { hashOpaqueToken, signPlatformToken } from '../auth/tokens';
import { config } from '../config';
import { unscopedQuery, withTx } from '../db/query';
import { AppError } from '../http/errors';
import { normalizeEmail } from '../users/service';
import {
  PLATFORM_REFRESH_COOKIE,
  issuePlatformRefreshToken,
  loadPlatformAdmin,
  platformAudit,
  platformCookieOptions,
  requirePlatformAdmin,
  revokeAllPlatformRefreshTokens,
} from './identity';

const loginBody = z.object({ email: z.string().trim().email().max(320), password: z.string().min(1).max(200) });
const changeBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(20) });

const INVALID_LOGIN = new AppError(401, 'invalid_credentials', 'Incorrect email or password key');
let dummyHash: Promise<string> | null = null;

export const platformAuthRouter = Router();

platformAuthRouter.use(
  rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, skip: () => config.isTest }),
);

platformAuthRouter.post('/login', async (req, res) => {
  const body = loginBody.parse(req.body);
  const email = normalizeEmail(body.email);

  const [admin] = await unscopedQuery<{ PlatformAdminId: number; PasswordHash: string; IsActive: boolean; Locked: number; HasKey: number }>(
    `SELECT PlatformAdminId, PasswordHash, IsActive,
            CASE WHEN LockedUntil > SYSUTCDATETIME() THEN 1 ELSE 0 END AS Locked,
            CASE WHEN PasswordSetAt IS NULL THEN 0 ELSE 1 END AS HasKey
       FROM PlatformAdmins WHERE Email = @Email`,
    { Email: email },
  );

  if (!admin || !admin.HasKey) {
    // burn the same CPU as a real verification so unknown addresses are not distinguishable by timing
    dummyHash ??= unusablePasswordHash();
    await verifyPassword(body.password, await dummyHash);
    throw INVALID_LOGIN;
  }

  const passwordOk = await verifyPassword(body.password, admin.PasswordHash);

  if (admin.Locked || !admin.IsActive) {
    await platformAudit(req, admin.PlatformAdminId, {
      action: admin.Locked ? 'platform.login_blocked_locked' : 'platform.login_blocked_inactive',
      entityType: 'PlatformAdmin',
      entityId: admin.PlatformAdminId,
    });
    throw INVALID_LOGIN;
  }

  if (!passwordOk) {
    await unscopedQuery(
      `UPDATE PlatformAdmins
          SET LockedUntil = CASE WHEN FailedLoginCount + 1 >= @Max THEN DATEADD(MINUTE, @LockMin, SYSUTCDATETIME()) ELSE LockedUntil END,
              FailedLoginCount = CASE WHEN FailedLoginCount + 1 >= @Max THEN 0 ELSE FailedLoginCount + 1 END
        WHERE PlatformAdminId = @Id`,
      { Id: admin.PlatformAdminId, Max: config.auth.maxFailedLogins, LockMin: config.auth.lockMinutes },
    );
    await platformAudit(req, admin.PlatformAdminId, { action: 'platform.login_failed', entityType: 'PlatformAdmin', entityId: admin.PlatformAdminId });
    throw INVALID_LOGIN;
  }

  await unscopedQuery('UPDATE PlatformAdmins SET FailedLoginCount = 0, LockedUntil = NULL WHERE PlatformAdminId = @Id', { Id: admin.PlatformAdminId });
  await issuePlatformRefreshToken(admin.PlatformAdminId, req, res);
  await platformAudit(req, admin.PlatformAdminId, { action: 'platform.login', entityType: 'PlatformAdmin', entityId: admin.PlatformAdminId });

  res.json({
    accessToken: signPlatformToken({ platformAdminId: admin.PlatformAdminId }),
    admin: await loadPlatformAdmin(admin.PlatformAdminId),
  });
});

platformAuthRouter.post('/refresh', async (req, res) => {
  const raw: unknown = req.cookies?.[PLATFORM_REFRESH_COOKIE];
  if (typeof raw !== 'string' || !raw) throw new AppError(401, 'unauthenticated', 'Sign in required');

  const [row] = await unscopedQuery<{ TokenId: number; PlatformAdminId: number; Revoked: number; Expired: number; JustRotated: number }>(
    `SELECT TokenId, PlatformAdminId,
            CASE WHEN RevokedAt IS NULL THEN 0 ELSE 1 END AS Revoked,
            CASE WHEN ExpiresAt <= SYSUTCDATETIME() THEN 1 ELSE 0 END AS Expired,
            CASE WHEN RevokedAt > DATEADD(SECOND, -10, SYSUTCDATETIME()) THEN 1 ELSE 0 END AS JustRotated
       FROM PlatformRefreshTokens WHERE TokenHash = @Hash`,
    { Hash: hashOpaqueToken(raw) },
  );
  const fail = () => {
    res.clearCookie(PLATFORM_REFRESH_COOKIE, { ...platformCookieOptions(), maxAge: undefined });
    return new AppError(401, 'unauthenticated', 'Sign in required');
  };
  if (!row || row.Expired) throw fail();
  if (row.Revoked && row.JustRotated) throw new AppError(401, 'refresh_race', 'Retry'); // two tabs refreshed at once
  if (row.Revoked) {
    // a rotated-out token came back: assume it was stolen and end every session
    await revokeAllPlatformRefreshTokens(row.PlatformAdminId);
    await platformAudit(req, row.PlatformAdminId, { action: 'platform.refresh_reuse_detected', entityType: 'PlatformAdmin', entityId: row.PlatformAdminId });
    throw fail();
  }

  const admin = await loadPlatformAdmin(row.PlatformAdminId);
  if (!admin) throw fail();

  await withTx(async (tx) => {
    const claimed = await unscopedQuery(
      `UPDATE PlatformRefreshTokens SET RevokedAt = SYSUTCDATETIME()
       OUTPUT inserted.TokenId WHERE TokenId = @TokenId AND RevokedAt IS NULL`,
      { TokenId: row.TokenId },
      tx,
    );
    if (claimed.length !== 1) throw new AppError(401, 'refresh_race', 'Retry'); // lost a race with a concurrent refresh
    await issuePlatformRefreshToken(row.PlatformAdminId, req, res, tx);
  });

  res.json({ accessToken: signPlatformToken({ platformAdminId: admin.platformAdminId }), admin });
});

platformAuthRouter.post('/logout', async (req, res) => {
  const raw: unknown = req.cookies?.[PLATFORM_REFRESH_COOKIE];
  if (typeof raw === 'string' && raw) {
    const rows = await unscopedQuery<{ PlatformAdminId: number }>(
      `UPDATE PlatformRefreshTokens SET RevokedAt = SYSUTCDATETIME()
       OUTPUT inserted.PlatformAdminId WHERE TokenHash = @Hash AND RevokedAt IS NULL`,
      { Hash: hashOpaqueToken(raw) },
    );
    if (rows[0]) {
      await platformAudit(req, rows[0].PlatformAdminId, { action: 'platform.logout', entityType: 'PlatformAdmin', entityId: rows[0].PlatformAdminId });
    }
  }
  res.clearCookie(PLATFORM_REFRESH_COOKIE, { ...platformCookieOptions(), maxAge: undefined });
  res.status(204).end();
});

platformAuthRouter.get('/me', requirePlatformAdmin, (req, res) => {
  res.json({ admin: req.platformAdmin });
});

platformAuthRouter.post('/change-key', requirePlatformAdmin, async (req, res) => {
  const body = changeBody.parse(req.body);
  const me = req.platformAdmin!;
  const [row] = await unscopedQuery<{ PasswordHash: string }>(
    'SELECT PasswordHash FROM PlatformAdmins WHERE PlatformAdminId = @Id',
    { Id: me.platformAdminId },
  );
  if (!row || !(await verifyPassword(body.currentPassword, row.PasswordHash))) throw INVALID_LOGIN;

  const problem = passwordKeyProblem(body.newPassword);
  if (problem) throw new AppError(400, 'validation_failed', 'Invalid input', [{ path: 'newPassword', message: problem }]);

  const hash = await hashPassword(body.newPassword);
  await withTx(async (tx) => {
    await unscopedQuery(
      'UPDATE PlatformAdmins SET PasswordHash = @Hash, PasswordSetAt = SYSUTCDATETIME() WHERE PlatformAdminId = @Id',
      { Hash: hash, Id: me.platformAdminId },
      tx,
    );
    await revokeAllPlatformRefreshTokens(me.platformAdminId, tx); // every other session is signed out
    await platformAudit(req, me.platformAdminId, { action: 'platform.key_changed', entityType: 'PlatformAdmin', entityId: me.platformAdminId }, tx);
  });
  await issuePlatformRefreshToken(me.platformAdminId, req, res);
  res.json({ accessToken: signPlatformToken({ platformAdminId: me.platformAdminId }) });
});
