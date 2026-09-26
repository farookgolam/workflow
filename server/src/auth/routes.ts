import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { actorFrom, audit } from '../audit/audit';
import { config } from '../config';
import { tenantQuery, unscopedQuery, withTx } from '../db/query';
import { AppError } from '../http/errors';
import { resolveTenantId } from '../tenant';
import { normalizeEmail } from '../users/service';
import { loadUser, requireAuth } from './middleware';
import { hashPassword, passwordKeyProblem, unusablePasswordHash, verifyPassword } from './password';
import { REFRESH_COOKIE, cookieOptions, issueRefreshToken, revokeAllRefreshTokens } from './session';
import { signupRouter } from './signup';
import { hashOpaqueToken, signAccessToken } from './tokens';

const loginBody = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(200),
  tenantSlug: z.string().trim().toLowerCase().max(63).optional(), // internal; the UI never sends it
});
const changeBody = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(20) });

const INVALID_LOGIN = new AppError(401, 'invalid_credentials', 'Incorrect email or password key');
let dummyHash: Promise<string> | null = null;

export const authRouter = Router();

authRouter.use(
  rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, skip: () => config.isTest }),
);
authRouter.use(signupRouter); // POST /start, /setup, /forgot, /reset-key

authRouter.post('/login', async (req, res) => {
  const body = loginBody.parse(req.body);
  const email = normalizeEmail(body.email);
  const tenantId = await resolveTenantId(req, body.tenantSlug).catch((err) => {
    if (err instanceof AppError && err.status === 401) return null;
    throw err;
  });

  const [user] = tenantId
    ? await tenantQuery<{ UserId: number; PasswordHash: string; IsActive: boolean; Locked: number; HasKey: number }>(
        tenantId,
        `SELECT UserId, PasswordHash, IsActive,
                CASE WHEN LockedUntil > SYSUTCDATETIME() THEN 1 ELSE 0 END AS Locked,
                CASE WHEN PasswordSetAt IS NULL THEN 0 ELSE 1 END AS HasKey
           FROM Users WHERE TenantId = @TenantId AND Email = @Email`,
        { Email: email },
      )
    : [];

  if (!tenantId || !user || !user.HasKey) {
    // burn the same CPU as a real verification so unknown emails are not distinguishable by timing
    dummyHash ??= unusablePasswordHash();
    await verifyPassword(body.password, await dummyHash);
    throw INVALID_LOGIN;
  }

  const actor = actorFrom(req, user.UserId);
  const passwordOk = await verifyPassword(body.password, user.PasswordHash);

  if (user.Locked || !user.IsActive) {
    await audit(tenantId, actor, {
      action: user.Locked ? 'auth.login_blocked_locked' : 'auth.login_blocked_inactive',
      entityType: 'User',
      entityId: user.UserId,
    });
    throw INVALID_LOGIN;
  }

  if (!passwordOk) {
    const [after] = await tenantQuery<{ LockedNow: number }>(
      tenantId,
      `UPDATE Users
          SET LockedUntil = CASE WHEN FailedLoginCount + 1 >= @Max THEN DATEADD(MINUTE, @LockMin, SYSUTCDATETIME()) ELSE LockedUntil END,
              FailedLoginCount = CASE WHEN FailedLoginCount + 1 >= @Max THEN 0 ELSE FailedLoginCount + 1 END
       OUTPUT CASE WHEN inserted.LockedUntil > SYSUTCDATETIME() THEN 1 ELSE 0 END AS LockedNow
        WHERE TenantId = @TenantId AND UserId = @UserId`,
      { UserId: user.UserId, Max: config.auth.maxFailedLogins, LockMin: config.auth.lockMinutes },
    );
    await audit(tenantId, actor, {
      action: after?.LockedNow ? 'auth.account_locked' : 'auth.login_failed',
      entityType: 'User',
      entityId: user.UserId,
    });
    throw INVALID_LOGIN;
  }

  await tenantQuery(
    tenantId,
    'UPDATE Users SET FailedLoginCount = 0, LockedUntil = NULL WHERE TenantId = @TenantId AND UserId = @UserId',
    { UserId: user.UserId },
  );
  await issueRefreshToken(tenantId, user.UserId, req, res);
  await audit(tenantId, actor, { action: 'auth.login', entityType: 'User', entityId: user.UserId });

  res.json({ accessToken: signAccessToken({ userId: user.UserId, tenantId }), user: await loadUser(tenantId, user.UserId) });
});

authRouter.post('/refresh', async (req, res) => {
  const raw: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof raw !== 'string' || !raw) throw new AppError(401, 'unauthenticated', 'Sign in required');

  const [row] = await unscopedQuery<{ TokenId: number; TenantId: number; UserId: number; Revoked: number; Expired: number; JustRotated: number }>(
    `SELECT TokenId, TenantId, UserId,
            CASE WHEN RevokedAt IS NULL THEN 0 ELSE 1 END AS Revoked,
            CASE WHEN ExpiresAt <= SYSUTCDATETIME() THEN 1 ELSE 0 END AS Expired,
            CASE WHEN RevokedAt > DATEADD(SECOND, -10, SYSUTCDATETIME()) THEN 1 ELSE 0 END AS JustRotated
       FROM RefreshTokens WHERE TokenHash = @Hash`,
    { Hash: hashOpaqueToken(raw) },
  );
  const fail = () => {
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
    return new AppError(401, 'unauthenticated', 'Sign in required');
  };
  if (!row || row.Expired) throw fail();

  if (row.Revoked && row.JustRotated) {
    // Two tabs refreshed at the same moment; the other one won. The browser already holds the
    // new cookie, so tell the client to simply try again rather than treating this as theft.
    throw new AppError(401, 'refresh_race', 'Retry');
  }
  if (row.Revoked) {
    // A rotated-out token came back: assume it was stolen and kill every session for this user.
    await revokeAllRefreshTokens(row.TenantId, row.UserId);
    await audit(row.TenantId, actorFrom(req, row.UserId), {
      action: 'auth.refresh_reuse_detected',
      entityType: 'User',
      entityId: row.UserId,
    });
    throw fail();
  }

  const user = await loadUser(row.TenantId, row.UserId);
  if (!user) throw fail();

  await withTx(async (tx) => {
    const claimed = await tenantQuery(
      row.TenantId,
      `UPDATE RefreshTokens SET RevokedAt = SYSUTCDATETIME()
       OUTPUT inserted.TokenId
        WHERE TenantId = @TenantId AND TokenId = @TokenId AND RevokedAt IS NULL`,
      { TokenId: row.TokenId },
      tx,
    );
    if (claimed.length !== 1) throw new AppError(401, 'refresh_race', 'Retry'); // lost a race with a concurrent refresh
    await issueRefreshToken(row.TenantId, row.UserId, req, res, tx);
  });
  res.json({ accessToken: signAccessToken({ userId: user.userId, tenantId: user.tenantId }), user });
});

authRouter.post('/logout', async (req, res) => {
  const raw: unknown = req.cookies?.[REFRESH_COOKIE];
  if (typeof raw === 'string' && raw) {
    const rows = await unscopedQuery<{ TenantId: number; UserId: number }>(
      `UPDATE RefreshTokens SET RevokedAt = SYSUTCDATETIME()
       OUTPUT inserted.TenantId, inserted.UserId
        WHERE TokenHash = @Hash AND RevokedAt IS NULL`,
      { Hash: hashOpaqueToken(raw) },
    );
    if (rows[0]) {
      await audit(rows[0].TenantId, actorFrom(req, rows[0].UserId), {
        action: 'auth.logout',
        entityType: 'User',
        entityId: rows[0].UserId,
      });
    }
  }
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.status(204).end();
});

// Forgotten key: self-service via an emailed code (POST /forgot + /reset-key in signup.ts), or an administrator
// reset (POST /admin/users/:id/reset-key), after which the user goes through first-time setup again.

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const body = changeBody.parse(req.body);
  const { tenantId, userId } = req.user!;
  const problem = passwordKeyProblem(body.newPassword);
  if (problem) throw new AppError(400, 'validation_failed', 'Invalid input', [{ path: 'newPassword', message: problem }]);

  const [row] = await tenantQuery<{ PasswordHash: string }>(
    tenantId,
    'SELECT PasswordHash FROM Users WHERE TenantId = @TenantId AND UserId = @UserId',
    { UserId: userId },
  );
  if (!row || !(await verifyPassword(body.currentPassword, row.PasswordHash))) {
    throw new AppError(400, 'wrong_password', 'Current password key is incorrect');
  }
  const passwordHash = await hashPassword(body.newPassword);
  await withTx(async (tx) => {
    await tenantQuery(
      tenantId,
      'UPDATE Users SET PasswordHash = @PasswordHash, PasswordSetAt = SYSUTCDATETIME() WHERE TenantId = @TenantId AND UserId = @UserId',
      { PasswordHash: passwordHash, UserId: userId },
      tx,
    );
    await revokeAllRefreshTokens(tenantId, userId, tx);
    await issueRefreshToken(tenantId, userId, req, res, tx); // keep this browser signed in
    await audit(tenantId, actorFrom(req), { action: 'auth.password_changed', entityType: 'User', entityId: userId }, tx);
  });
  res.status(204).end();
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});
