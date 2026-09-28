// First-time setup: a person signs in with just their email address and creates their own 6-digit
// password key. No administrator is involved. A forgotten key is self-service too (POST /auth/forgot,
// /auth/reset-key); an administrator reset remains as a fallback and leads back into first-time setup. To stop someone claiming an address that is not theirs, a one-time code is
// emailed to that address first (config.signup.verifyEmail).
//
//   POST /auth/start  { email }                                   -> { next: 'password' } | { next: 'setup', ... }
//   POST /auth/setup  { email, passwordKey, code?, displayName? } -> signed in
import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { actorFrom, audit } from '../audit/audit';
import { config } from '../config';
import { tenantQuery, withTx } from '../db/query';
import { AppError } from '../http/errors';
import { emailBody, queueNotification } from '../notifications/outbox';
import { effectiveSettings } from '../settings/service';
import { resolveTenantId } from '../tenant';
import { createUser, normalizeEmail } from '../users/service';
import { loadUser } from './middleware';
import { hashPassword, passwordKeyProblem, unusablePasswordHash } from './password';
import { issueRefreshToken, revokeAllRefreshTokens } from './session';
import { signAccessToken } from './tokens';

const email = z.string().trim().email().max(320);
const startBody = z.object({ email, tenantSlug: z.string().max(63).optional() });
const setupBody = z.object({
  email,
  passwordKey: z.string().max(20),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the email').optional(),
  displayName: z.string().trim().min(2).max(200).optional(),
  tenantSlug: z.string().max(63).optional(),
});

// The code has only a million possibilities, so a plain hash would be reversible from a database copy: key it.
const codeHash = (addr: string, code: string) => crypto.createHmac('sha256', config.auth.jwtSecret).update(`${addr}\n${code}`).digest();

/** Which addresses may register here - a per-customer setting, falling back to ALLOWED_EMAIL_DOMAINS. */
export async function assertDomainAllowed(tenantId: number, addr: string): Promise<void> {
  const allowed = (await effectiveSettings(tenantId)).signup.allowedDomains;
  if (allowed.length && !allowed.includes(addr.split('@')[1])) {
    throw new AppError(403, 'domain_not_allowed', 'Only your organisation\'s email addresses can be used here');
  }
}

/** Whether first sign-in must prove the address with an emailed code - per customer, falling back to the server setting. */
const verifyEmailFor = async (tenantId: number) => (await effectiveSettings(tenantId)).signup.verifyEmail;

interface Account { UserId: number; IsActive: boolean; HasKey: number; DisplayName: string }
const findAccount = async (tenantId: number, addr: string) =>
  (
    await tenantQuery<Account>(
      tenantId,
      'SELECT UserId, IsActive, CASE WHEN PasswordSetAt IS NULL THEN 0 ELSE 1 END AS HasKey, DisplayName FROM Users WHERE TenantId = @TenantId AND Email = @Email',
      { Email: addr },
    )
  )[0];

const badCode = (message: string) => new AppError(400, 'validation_failed', 'Invalid input', [{ path: 'code', message }]);

/**
 * Checks the emailed code and returns its id. A wrong guess is counted and COMMITTED before the error is
 * raised (its own statement, outside the setup transaction), so the 5-attempt limit cannot be rolled back.
 */
async function checkCode(tenantId: number, addr: string, code: string | undefined): Promise<number> {
  if (!code) throw badCode('Enter the 6-digit code from the email');
  const [v] = await tenantQuery<{ VerificationId: number; CodeHash: Buffer; Attempts: number; Expired: number }>(
    tenantId,
    `SELECT TOP 1 VerificationId, CodeHash, Attempts, CASE WHEN ExpiresAt <= SYSUTCDATETIME() THEN 1 ELSE 0 END AS Expired
       FROM EmailVerifications WHERE TenantId = @TenantId AND Email = @Email AND ConsumedAt IS NULL ORDER BY VerificationId DESC`,
    { Email: addr },
  );
  if (!v || v.Expired || v.Attempts >= config.signup.codeMaxAttempts) throw badCode('This code has expired. Go back and request a new one.');
  if (!crypto.timingSafeEqual(v.CodeHash, codeHash(addr, code))) {
    await tenantQuery(tenantId, 'UPDATE EmailVerifications SET Attempts = Attempts + 1 WHERE TenantId = @TenantId AND VerificationId = @Id', { Id: v.VerificationId });
    throw badCode('That code is not right. Check the latest email and try again.');
  }
  return v.VerificationId;
}

/** Emails a fresh one-time code (and retires any earlier one). At most one per address per minute, so it cannot be used to flood a mailbox. */
async function sendCode(tenantId: number, addr: string, userId: number | null, ip: string | null, intro: string): Promise<void> {
  await withTx(async (tx) => {
    const [recent] = await tenantQuery<{ n: number }>(
      tenantId,
      `SELECT COUNT(*) AS n FROM EmailVerifications WITH (UPDLOCK, HOLDLOCK)
        WHERE TenantId = @TenantId AND Email = @Email AND CreatedAt > DATEADD(SECOND, -@Wait, SYSUTCDATETIME())`,
      { Email: addr, Wait: config.signup.codeResendSeconds },
      tx,
    );
    if (recent.n > 0) return;

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await tenantQuery(
      tenantId,
      `UPDATE EmailVerifications SET ConsumedAt = SYSUTCDATETIME() WHERE TenantId = @TenantId AND Email = @Email AND ConsumedAt IS NULL;
       INSERT INTO EmailVerifications (TenantId, Email, CodeHash, ExpiresAt, CreatedIp)
       VALUES (@TenantId, @Email, @Hash, DATEADD(MINUTE, @Ttl, SYSUTCDATETIME()), @Ip)`,
      { Email: addr, Hash: codeHash(addr, code), Ttl: config.signup.codeTtlMinutes, Ip: ip },
      tx,
    );
    await queueNotification(
      tenantId,
      {
        type: 'VerificationCode',
        to: { userId, email: addr },
        subject: `${code} is your approvals verification code`,
        bodyHtml: emailBody([
          intro,
          { label: 'Verification code', value: code },
          `The code expires in ${config.signup.codeTtlMinutes} minutes. If you did not ask for it, you can ignore this email - nobody can use your address without it.`,
        ]),
      },
      tx,
    );
    if (config.env === 'development') console.log(`[dev] verification code for ${addr}: ${code}`);
  });
}

export const signupRouter = Router();

signupRouter.post('/start', async (req, res) => {
  const body = startBody.parse(req.body);
  const addr = normalizeEmail(body.email);
  const tenantId = await resolveTenantId(req, body.tenantSlug);
  const account = await findAccount(tenantId, addr);

  // Has a key (or is deactivated): go to the normal sign-in, which gives nothing further away.
  if (account && (account.HasKey || !account.IsActive)) {
    res.json({ next: 'password' });
    return;
  }
  if (!account) await assertDomainAllowed(tenantId, addr);

  const verifyEmail = await verifyEmailFor(tenantId);
  if (verifyEmail) await sendCode(tenantId, addr, account?.UserId ?? null, req.ip ?? null, 'Use this code to finish setting up your password key:');
  res.json({ next: 'setup', verification: verifyEmail, needsName: !account, displayName: account?.DisplayName ?? null });
});

signupRouter.post('/setup', async (req, res) => {
  const body = setupBody.parse(req.body);
  const addr = normalizeEmail(body.email);
  const tenantId = await resolveTenantId(req, body.tenantSlug);

  const problem = passwordKeyProblem(body.passwordKey);
  if (problem) throw new AppError(400, 'validation_failed', 'Invalid input', [{ path: 'passwordKey', message: problem }]);
  const passwordHash = await hashPassword(body.passwordKey);

  const ALREADY = new AppError(409, 'already_set_up', 'This account already has a password key. Sign in, or ask an administrator to reset it.');
  const existing = await findAccount(tenantId, addr);
  if (existing && (existing.HasKey || !existing.IsActive)) throw ALREADY; // checked again under lock below
  const verifyEmail = await verifyEmailFor(tenantId);
  const verificationId = verifyEmail ? await checkCode(tenantId, addr, body.code) : null;

  const userId = await withTx(async (tx) => {
    const [account] = await tenantQuery<Account>(
      tenantId,
      `SELECT UserId, IsActive, CASE WHEN PasswordSetAt IS NULL THEN 0 ELSE 1 END AS HasKey, DisplayName
         FROM Users WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND Email = @Email`,
      { Email: addr },
      tx,
    );
    // Setup can never overwrite an existing key - that is what makes a forgotten key an administrator matter.
    if (account && (account.HasKey || !account.IsActive)) throw ALREADY;
    if (!account) {
      await assertDomainAllowed(tenantId, addr);
      if (!body.displayName) throw new AppError(400, 'validation_failed', 'Invalid input', [{ path: 'displayName', message: 'Please enter your full name' }]);
    }

    if (verificationId !== null) {
      // single use: claiming the code is part of this transaction, so two racing setups cannot both succeed
      const claimed = await tenantQuery(
        tenantId,
        'UPDATE EmailVerifications SET ConsumedAt = SYSUTCDATETIME() OUTPUT inserted.VerificationId WHERE TenantId = @TenantId AND VerificationId = @Id AND ConsumedAt IS NULL',
        { Id: verificationId },
        tx,
      );
      if (!claimed.length) throw badCode('This code has already been used. Go back and request a new one.');
    }

    let id: number;
    if (account) {
      id = account.UserId;
      await tenantQuery(
        tenantId,
        `UPDATE Users SET PasswordHash = @Hash, PasswordSetAt = SYSUTCDATETIME(), FailedLoginCount = 0, LockedUntil = NULL
          WHERE TenantId = @TenantId AND UserId = @UserId AND PasswordSetAt IS NULL`,
        { Hash: passwordHash, UserId: id },
        tx,
      );
      await revokeAllRefreshTokens(tenantId, id, tx);
      await audit(tenantId, actorFrom(req, id), { action: 'auth.key_created', entityType: 'User', entityId: id, detail: { emailVerified: verifyEmail } }, tx);
    } else {
      // everyone starts as a Submitter; an administrator grants Approver / Admin afterwards
      id = await createUser(tenantId, { email: addr, displayName: body.displayName!, roles: ['Submitter'], passwordHash }, tx);
      await audit(tenantId, actorFrom(req, id), { action: 'auth.account_created', entityType: 'User', entityId: id, detail: { email: addr, emailVerified: verifyEmail } }, tx);
    }
    await issueRefreshToken(tenantId, id, req, res, tx);
    return id;
  });

  res.status(201).json({ accessToken: signAccessToken({ userId, tenantId }), user: await loadUser(tenantId, userId) });
});

// ---------------------------------------------------------------------------------------
// Forgotten key, self-service: prove you can read the mailbox, then choose a new key.
// The emailed code is ALWAYS required here, whatever FIRST_LOGIN_EMAIL_VERIFICATION says -
// without it this would be "type someone's email, take their account".
// ---------------------------------------------------------------------------------------
signupRouter.post('/forgot', async (req, res) => {
  const body = startBody.parse(req.body);
  const addr = normalizeEmail(body.email);
  const tenantId = await resolveTenantId(req, body.tenantSlug);
  const account = await findAccount(tenantId, addr);
  if (account && account.IsActive && account.HasKey) {
    await sendCode(tenantId, addr, account.UserId, req.ip ?? null, 'Use this code to choose a new password key:');
    await audit(tenantId, actorFrom(req, null), { action: 'auth.key_reset_requested', entityType: 'User', entityId: account.UserId });
  }
  // same answer whether or not the address has an account
  res.status(202).json({ message: 'If that address has an account, a 6-digit code has been emailed to it.' });
});

const resetBody = setupBody.pick({ email: true, passwordKey: true, tenantSlug: true }).extend({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code from the email') });

signupRouter.post('/reset-key', async (req, res) => {
  const body = resetBody.parse(req.body);
  const addr = normalizeEmail(body.email);
  const tenantId = await resolveTenantId(req, body.tenantSlug);
  const problem = passwordKeyProblem(body.passwordKey);
  if (problem) throw new AppError(400, 'validation_failed', 'Invalid input', [{ path: 'passwordKey', message: problem }]);
  const passwordHash = await hashPassword(body.passwordKey);

  const verificationId = await checkCode(tenantId, addr, body.code); // unknown address -> no code was ever issued -> same "expired" error

  const userId = await withTx(async (tx) => {
    const claimed = await tenantQuery(
      tenantId,
      'UPDATE EmailVerifications SET ConsumedAt = SYSUTCDATETIME() OUTPUT inserted.VerificationId WHERE TenantId = @TenantId AND VerificationId = @Id AND ConsumedAt IS NULL',
      { Id: verificationId },
      tx,
    );
    if (!claimed.length) throw badCode('This code has already been used. Request a new one.');
    const [user] = await tenantQuery<{ UserId: number }>(
      tenantId,
      `UPDATE Users SET PasswordHash = @Hash, PasswordSetAt = SYSUTCDATETIME(), FailedLoginCount = 0, LockedUntil = NULL
       OUTPUT inserted.UserId WHERE TenantId = @TenantId AND Email = @Email AND IsActive = 1 AND PasswordSetAt IS NOT NULL`,
      { Hash: passwordHash, Email: addr },
      tx,
    );
    if (!user) throw badCode('This code has expired. Request a new one.');
    await revokeAllRefreshTokens(tenantId, user.UserId, tx); // anyone who knew the old key is signed out
    await audit(tenantId, actorFrom(req, user.UserId), { action: 'auth.key_reset_self', entityType: 'User', entityId: user.UserId }, tx);
    await issueRefreshToken(tenantId, user.UserId, req, res, tx);
    return user.UserId;
  });
  res.json({ accessToken: signAccessToken({ userId, tenantId }), user: await loadUser(tenantId, userId) });
});

/** Administrator action: forget a user's key. They create a new one at next sign-in (with email verification). */
export async function resetPasswordKey(tenantId: number, userId: number, tx: Parameters<typeof revokeAllRefreshTokens>[2]): Promise<boolean> {
  const rows = await tenantQuery(
    tenantId,
    `UPDATE Users SET PasswordHash = @Hash, PasswordSetAt = NULL, FailedLoginCount = 0, LockedUntil = NULL
     OUTPUT inserted.UserId WHERE TenantId = @TenantId AND UserId = @UserId`,
    { Hash: await unusablePasswordHash(), UserId: userId },
    tx,
  );
  if (!rows.length) return false;
  await revokeAllRefreshTokens(tenantId, userId, tx);
  return true;
}
