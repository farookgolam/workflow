// Managing the global administrators themselves: /api/v1/global/admins/*  (behind requirePlatformAdmin)
//
// Any global administrator can add another, deactivate or reactivate one, or give one a new key.
// Nobody can deactivate or reset themselves here - their own key is changed with /auth/change-key,
// which asks for the current one - so the caller is always an active administrator and the
// installation can never be left with none.
import { Router } from 'express';
import { z } from 'zod';
import { hashPassword } from '../auth/password';
import { unscopedQuery, withTx } from '../db/query';
import { AppError } from '../http/errors';
import { normalizeEmail } from '../users/service';
import { platformAudit, revokeAllPlatformRefreshTokens } from './identity';
import { randomPasswordKey } from './provision';

export const platformAdminsRouter = Router();

const createBody = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().min(2).max(200),
});

const patchBody = z.object({
  displayName: z.string().trim().min(2).max(200).optional(),
  isActive: z.boolean().optional(),
});

interface AdminRow {
  PlatformAdminId: number;
  Email: string;
  DisplayName: string;
  IsActive: boolean;
  Locked: number;
  CreatedAt: Date;
  LastSignInAt: Date | null;
}

const LIST = `
  SELECT a.PlatformAdminId, a.Email, a.DisplayName, a.IsActive, a.CreatedAt,
         CASE WHEN a.LockedUntil > SYSUTCDATETIME() THEN 1 ELSE 0 END AS Locked,
         (SELECT MAX(l.CreatedAt) FROM PlatformAuditLog l
           WHERE l.PlatformAdminId = a.PlatformAdminId AND l.Action = 'platform.login') AS LastSignInAt
    FROM PlatformAdmins a`;

const shape = (r: AdminRow) => ({
  platformAdminId: r.PlatformAdminId,
  email: r.Email,
  displayName: r.DisplayName,
  isActive: r.IsActive,
  locked: r.Locked === 1,
  createdAt: r.CreatedAt,
  lastSignInAt: r.LastSignInAt,
});

async function loadOr404(id: number): Promise<AdminRow> {
  const [row] = await unscopedQuery<AdminRow>(`${LIST} WHERE a.PlatformAdminId = @Id`, { Id: id });
  if (!row) throw new AppError(404, 'not_found', 'No such global administrator');
  return row;
}

const notSelf = (id: number, myId: number, what: string) => {
  if (id === myId) throw new AppError(409, 'self', `You cannot ${what} yourself here`);
};

platformAdminsRouter.get('/', async (_req, res) => {
  const rows = await unscopedQuery<AdminRow>(`${LIST} ORDER BY a.IsActive DESC, a.DisplayName`);
  res.json({ admins: rows.map(shape) });
});

/** Add a global administrator. The generated key is shown once; they can change it after signing in. */
platformAdminsRouter.post('/', async (req, res) => {
  const body = createBody.parse(req.body);
  const me = req.platformAdmin!;
  const email = normalizeEmail(body.email);

  const taken = await unscopedQuery('SELECT 1 AS x FROM PlatformAdmins WHERE Email = @Email', { Email: email });
  if (taken.length) throw new AppError(409, 'email_taken', `${email} is already a global administrator`);

  const key = randomPasswordKey();
  const hash = await hashPassword(key);
  const id = await withTx(async (tx) => {
    const [row] = await unscopedQuery<{ PlatformAdminId: number }>(
      `INSERT INTO PlatformAdmins (Email, PasswordHash, DisplayName, PasswordSetAt)
       OUTPUT inserted.PlatformAdminId VALUES (@Email, @Hash, @Name, SYSUTCDATETIME())`,
      { Email: email, Hash: hash, Name: body.displayName },
      tx,
    );
    await platformAudit(req, me.platformAdminId, {
      action: 'platform_admin.created',
      entityType: 'PlatformAdmin',
      entityId: row.PlatformAdminId,
      detail: { email, displayName: body.displayName },
    }, tx);
    return row.PlatformAdminId;
  });

  res.status(201).json({ admin: shape(await loadOr404(id)), generatedKey: key });
});

/** Rename, deactivate or reactivate. Deactivating ends their open sessions at once. */
platformAdminsRouter.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = patchBody.parse(req.body);
  const me = req.platformAdmin!;
  if (body.isActive !== undefined) notSelf(id, me.platformAdminId, body.isActive ? 'reactivate' : 'deactivate');
  const before = await loadOr404(id);

  await withTx(async (tx) => {
    await unscopedQuery(
      `UPDATE PlatformAdmins
          SET DisplayName = COALESCE(@Name, DisplayName),
              IsActive = COALESCE(@IsActive, IsActive),
              FailedLoginCount = CASE WHEN @IsActive = 1 THEN 0 ELSE FailedLoginCount END,
              LockedUntil = CASE WHEN @IsActive = 1 THEN NULL ELSE LockedUntil END
        WHERE PlatformAdminId = @Id`,
      { Id: id, Name: body.displayName ?? null, IsActive: body.isActive === undefined ? null : body.isActive },
      tx,
    );
    if (body.isActive === false) await revokeAllPlatformRefreshTokens(id, tx);
    await platformAudit(req, me.platformAdminId, {
      action: body.isActive === false ? 'platform_admin.deactivated' : body.isActive === true ? 'platform_admin.reactivated' : 'platform_admin.updated',
      entityType: 'PlatformAdmin',
      entityId: id,
      detail: { email: before.Email, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) },
    }, tx);
  });

  res.json({ admin: shape(await loadOr404(id)) });
});

/** Give another administrator a new generated key (shown once), unlock them and sign them out everywhere. */
platformAdminsRouter.post('/:id/reset-key', async (req, res) => {
  const id = Number(req.params.id);
  const me = req.platformAdmin!;
  notSelf(id, me.platformAdminId, 'reset the key of');
  const target = await loadOr404(id);
  if (!target.IsActive) throw new AppError(409, 'inactive', 'Reactivate this administrator first');

  const key = randomPasswordKey();
  const hash = await hashPassword(key);
  await withTx(async (tx) => {
    await unscopedQuery(
      `UPDATE PlatformAdmins
          SET PasswordHash = @Hash, PasswordSetAt = SYSUTCDATETIME(), FailedLoginCount = 0, LockedUntil = NULL
        WHERE PlatformAdminId = @Id`,
      { Id: id, Hash: hash },
      tx,
    );
    await revokeAllPlatformRefreshTokens(id, tx);
    await platformAudit(req, me.platformAdminId, { action: 'platform_admin.key_reset', entityType: 'PlatformAdmin', entityId: id, detail: { email: target.Email } }, tx);
  });

  res.json({ admin: shape(await loadOr404(id)), generatedKey: key });
});
