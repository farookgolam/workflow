import { Router } from 'express';
import { z } from 'zod';
import { actorFrom, audit } from '../audit/audit';
import { resetPasswordKey } from '../auth/signup';
import { tenantQuery, withTx } from '../db/query';
import { AppError } from '../http/errors';
import { idParam } from '../workflow/routes';

// Mounted behind requireAuth + requireRole('Admin').
// Administrators do NOT create users: people register themselves at first sign-in (auth/signup.ts) and start as
// Submitters. Admins grant roles, deactivate leavers, and reset a forgotten password key.
export const adminUsersRouter = Router();

adminUsersRouter.get('/', async (req, res) => {
  const rows = await tenantQuery<{ UserId: number; Email: string; DisplayName: string; IsActive: boolean; Roles: string | null }>(
    req.user!.tenantId,
    `SELECT u.UserId, u.Email, u.DisplayName, u.IsActive, CASE WHEN u.PasswordSetAt IS NULL THEN 0 ELSE 1 END AS HasKey,
            CASE WHEN u.LockedUntil > SYSUTCDATETIME() THEN 1 ELSE 0 END AS Locked, u.CreatedAt,
            (SELECT STRING_AGG(r.Role, ',') FROM UserRoles r WHERE r.TenantId = u.TenantId AND r.UserId = u.UserId) AS Roles
       FROM Users u WHERE u.TenantId = @TenantId ORDER BY u.DisplayName`,
  );
  res.json({
    users: rows.map((r) => ({
      userId: r.UserId,
      email: r.Email,
      displayName: r.DisplayName,
      isActive: r.IsActive,
      hasKey: (r as unknown as { HasKey: number }).HasKey === 1,
      locked: (r as unknown as { Locked: number }).Locked === 1,
      createdAt: (r as unknown as { CreatedAt: Date }).CreatedAt,
      roles: r.Roles ? r.Roles.split(',') : [],
    })),
  });
});

const patchBody = z
  .object({
    displayName: z.string().trim().min(1).max(200).optional(),
    roles: z.array(z.enum(['Admin', 'Approver', 'Submitter'])).min(1).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');

adminUsersRouter.patch('/:userId', async (req, res) => {
  const body = patchBody.parse(req.body);
  const { tenantId, userId: me } = req.user!;
  const userId = idParam(req.params.userId);

  // an admin cannot lock themselves (or the whole tenant) out
  if (userId === me && (body.isActive === false || (body.roles && !body.roles.includes('Admin')))) {
    throw new AppError(400, 'self_lockout', 'You cannot deactivate yourself or remove your own Admin role');
  }
  const pendingApprovals = await withTx(async (tx) => {
    const [existing] = await tenantQuery<{ IsActive: boolean }>(tenantId, 'SELECT IsActive FROM Users WITH (UPDLOCK) WHERE TenantId = @TenantId AND UserId = @UserId', { UserId: userId }, tx);
    if (!existing) throw new AppError(404, 'not_found', 'User not found');

    if (body.displayName !== undefined || body.isActive !== undefined) {
      await tenantQuery(
        tenantId,
        'UPDATE Users SET DisplayName = COALESCE(@Name, DisplayName), IsActive = COALESCE(@Active, IsActive) WHERE TenantId = @TenantId AND UserId = @UserId',
        { Name: body.displayName ?? null, Active: body.isActive === undefined ? null : body.isActive ? 1 : 0, UserId: userId },
        tx,
      );
    }
    if (body.roles) {
      await tenantQuery(tenantId, 'DELETE FROM UserRoles WHERE TenantId = @TenantId AND UserId = @UserId', { UserId: userId }, tx);
      for (const role of new Set(body.roles)) {
        await tenantQuery(tenantId, 'INSERT INTO UserRoles (TenantId, UserId, Role) VALUES (@TenantId, @UserId, @Role)', { UserId: userId, Role: role }, tx);
      }
    }
    if (body.isActive === false) {
      await tenantQuery(tenantId, 'UPDATE RefreshTokens SET RevokedAt = SYSUTCDATETIME() WHERE TenantId = @TenantId AND UserId = @UserId AND RevokedAt IS NULL', { UserId: userId }, tx);
    }
    await audit(tenantId, actorFrom(req), { action: 'user.updated', entityType: 'User', entityId: userId, detail: body }, tx);

    // surfaced to the admin so stranded approvals get reassigned
    const [p] = await tenantQuery<{ n: number }>(
      tenantId,
      `SELECT COUNT(*) AS n FROM RequestSteps WHERE TenantId = @TenantId AND AssignedUserId = @UserId AND Status IN ('Active','Waiting')`,
      { UserId: userId },
      tx,
    );
    return p.n;
  });
  res.json({ pendingApprovals });
});

/**
 * The one thing only an administrator can do for an account: forget its password key.
 * The user is signed out everywhere and creates a new key at next sign-in (proving the address is theirs again).
 */
adminUsersRouter.post('/:userId/reset-key', async (req, res) => {
  const { tenantId } = req.user!;
  const userId = idParam(req.params.userId);
  await withTx(async (tx) => {
    if (!(await resetPasswordKey(tenantId, userId, tx))) throw new AppError(404, 'not_found', 'User not found');
    await audit(tenantId, actorFrom(req), { action: 'user.key_reset', entityType: 'User', entityId: userId }, tx);
  });
  res.status(204).end();
});
