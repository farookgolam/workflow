// The global management API: /api/v1/global/tenants/*  (behind requirePlatformAdmin)
//
// Cross-tenant reads happen through the handful of explicit aggregate queries below, never by handing
// a tenant id from the URL to a customer-facing handler. Anything that acts INSIDE a customer goes
// through the customer's own code paths, so tenantQuery's guarantee is never bypassed.
import { Router } from 'express';
import { z } from 'zod';
import { audit, systemActor } from '../audit/audit';
import { settingsPatchBody } from '../admin/settings.routes';
import { unusablePasswordHash } from '../auth/password';
import { resetPasswordKey } from '../auth/signup';
import { signAccessToken } from '../auth/tokens';
import { config } from '../config';
import { tenantQuery, unscopedQuery, withTx } from '../db/query';
import { AppError } from '../http/errors';
import { settingsForApi, updateSettings } from '../settings/service';
import { createUser, normalizeEmail, queueAccountCreatedEmail } from '../users/service';
import { forgetTenant, tenantBaseUrl } from '../tenant';
import { platformAudit } from './identity';
import { checkFileRoot } from '../customer-files/files';
import { exportQuery, previewExport } from '../archive/export';
import { sendExport } from '../archive/export.routes';
import { hostSchema, provisionTenant, slugSchema } from './provision';
import { customersWorkbook } from './tenants-export';

export const platformTenantsRouter = Router();

const createBody = z.object({
  name: z.string().trim().min(1).max(200),
  slug: slugSchema,
  host: hostSchema.optional().nullable(),
  adminEmail: z.string().trim().email().max(320),
  adminDisplayName: z.string().trim().min(2).max(200),
  adminKey: z.string().regex(/^\d{6}$/, 'The password key must be exactly 6 digits').optional(),
  notifyEmail: z.string().trim().email().max(320).optional().nullable(),
  // a folder for this customer's files (PDFs, attachments) instead of the database; checked before it is saved
  fileStorageRoot: z.string().trim().max(400).optional().nullable(),
});

const patchBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  host: hostSchema.optional().nullable(),
  notifyEmail: z.string().trim().email().max(320).optional().nullable(),
  isActive: z.boolean().optional(),
  fileStorageRoot: z.string().trim().max(400).optional().nullable(), // '' or null: back to the database, for new files
});

interface TenantRow {
  TenantId: number;
  Name: string;
  Slug: string;
  Host: string | null;
  AdminNotifyEmail: string | null;
  IsActive: boolean;
  CreatedAt: Date;
  Users: number;
  Admins: number;
  StorageBytes: number | string;
  Forms: number;
  Requests: number;
  OpenRequests: number;
  LastActivityAt: Date | null;
  RemovedAt: Date | null;
  PurgeAfter: Date | null;
  FileStorageRoot: string | null;
}

const shape = (r: TenantRow) => ({
  tenantId: r.TenantId,
  name: r.Name,
  slug: r.Slug,
  host: r.Host,
  url: tenantBaseUrl({ slug: r.Slug, host: r.Host }),
  notifyEmail: r.AdminNotifyEmail,
  isActive: r.IsActive,
  createdAt: r.CreatedAt,
  counts: { users: r.Users, admins: r.Admins, forms: r.Forms, requests: r.Requests, openRequests: r.OpenRequests },
  // bytes of its final PDFs and approvers' documents (a BIGINT arrives as text)
  storageBytes: Number(r.StorageBytes),
  lastActivityAt: r.LastActivityAt,
  // set once a global administrator removes it: the data is deleted for good at purgeAfter
  removedAt: r.RemovedAt,
  purgeAfter: r.PurgeAfter,
  // null: files are kept in the database
  fileStorageRoot: r.FileStorageRoot,
});

const SUMMARY = `
  SELECT t.TenantId, t.Name, t.Slug, t.Host, t.AdminNotifyEmail, t.IsActive, t.CreatedAt, t.RemovedAt, t.PurgeAfter, t.FileStorageRoot,
         (SELECT COUNT(*) FROM Users u WHERE u.TenantId = t.TenantId AND u.IsActive = 1) AS Users,
         (SELECT COUNT(*) FROM UserRoles r JOIN Users au ON au.TenantId = r.TenantId AND au.UserId = r.UserId
           WHERE r.TenantId = t.TenantId AND r.Role = 'Admin' AND au.IsActive = 1) AS Admins,
         -- what its files take up: final PDFs and approvers' documents, in the database or in its own folder.
         -- The size of each was recorded when it was saved, so nothing is read from disk here.
         (SELECT COALESCE(SUM(CAST(d.SizeBytes AS BIGINT)), 0) FROM RequestDocuments d WHERE d.TenantId = t.TenantId)
           + (SELECT COALESCE(SUM(CAST(s.SizeBytes AS BIGINT)), 0) FROM StepAttachments s WHERE s.TenantId = t.TenantId) AS StorageBytes,
         (SELECT COUNT(*) FROM Forms f WHERE f.TenantId = t.TenantId AND f.IsActive = 1) AS Forms,
         (SELECT COUNT(*) FROM Requests q WHERE q.TenantId = t.TenantId) AS Requests,
         (SELECT COUNT(*) FROM Requests q WHERE q.TenantId = t.TenantId AND q.Status = 'InProgress') AS OpenRequests,
         (SELECT MAX(a.OccurredAt) FROM AuditLog a WHERE a.TenantId = t.TenantId) AS LastActivityAt
    FROM Tenants t`;

platformTenantsRouter.get('/', async (_req, res) => {
  const rows = await unscopedQuery<TenantRow>(`${SUMMARY} ORDER BY t.Name`);
  res.json({ tenants: rows.map(shape) });
});

// Every customer with all the console knows about it, as one Excel sheet. (Before '/:tenantId', or "export.xlsx"
// would be taken for a customer's number.)
platformTenantsRouter.get('/export.xlsx', async (req, res) => {
  const { file, customers } = await customersWorkbook();
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await platformAudit(req, req.platformAdmin!.platformAdminId, { action: 'tenants.exported', entityType: 'Tenant', detail: { customers } });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="FileBank-WorkFlow-Customers_${day}.xlsx"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(file);
});

async function loadOr404(tenantId: number): Promise<TenantRow> {
  const [row] = await unscopedQuery<TenantRow>(`${SUMMARY} WHERE t.TenantId = @Id`, { Id: tenantId });
  if (!row) throw new AppError(404, 'not_found', 'No such organisation');
  return row;
}

/** For changes: a removed customer is frozen until it is restored (or deleted). */
async function loadEditableOr404(tenantId: number): Promise<TenantRow> {
  const row = await loadOr404(tenantId);
  if (row.RemovedAt) throw new AppError(409, 'removed', 'This organisation has been removed. Restore it first');
  return row;
}

platformTenantsRouter.get('/:tenantId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const row = await loadOr404(tenantId);
  const admins = await tenantQuery<{ UserId: number; Email: string; DisplayName: string; IsActive: boolean; HasKey: number }>(
    tenantId,
    `SELECT u.UserId, u.Email, u.DisplayName, u.IsActive, CASE WHEN u.PasswordSetAt IS NULL THEN 0 ELSE 1 END AS HasKey
       FROM Users u JOIN UserRoles r ON r.TenantId = u.TenantId AND r.UserId = u.UserId
      WHERE u.TenantId = @TenantId AND r.Role = 'Admin' ORDER BY u.Email`,
  );
  res.json({
    tenant: shape(row),
    admins: admins.map((a) => ({ userId: a.UserId, email: a.Email, displayName: a.DisplayName, isActive: a.IsActive, hasKey: a.HasKey === 1 })),
  });
});

/** Create a customer and its first administrator. The generated key is shown once and never again. */
platformTenantsRouter.post('/', async (req, res) => {
  const body = createBody.parse(req.body);
  const me = req.platformAdmin!;
  const fileStorageRoot = body.fileStorageRoot ? await checkFileRoot(body.fileStorageRoot) : null;

  const provisioned = await provisionTenant(
    {
      name: body.name,
      slug: body.slug,
      host: body.host ?? null,
      notifyEmail: body.notifyEmail ?? null,
      admin: { email: body.adminEmail, displayName: body.adminDisplayName },
      adminKey: body.adminKey,
      fileStorageRoot,
    },
    { platformAdminEmail: me.email },
  );

  await platformAudit(req, me.platformAdminId, {
    action: 'tenant.created',
    entityType: 'Tenant',
    entityId: provisioned.tenantId,
    tenantId: provisioned.tenantId,
    detail: { slug: body.slug, host: body.host ?? null, admin: body.adminEmail, fileStorageRoot },
  });

  const row = await loadOr404(provisioned.tenantId);
  res.status(201).json({
    tenant: shape(row),
    admin: { userId: provisioned.adminUserId, email: body.adminEmail },
    // shown once: the administrator signs in with it and can change it afterwards
    generatedAdminKey: provisioned.generatedAdminKey,
  });
});

/** Rename, move to another host, change the notification address, suspend or reactivate. */
platformTenantsRouter.patch('/:tenantId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const body = patchBody.parse(req.body);
  const me = req.platformAdmin!;
  const before = await loadEditableOr404(tenantId);
  const fileRootGiven = 'fileStorageRoot' in body;
  const fileStorageRoot = body.fileStorageRoot ? await checkFileRoot(body.fileStorageRoot) : null;

  if (body.host) {
    const clash = await unscopedQuery('SELECT 1 AS x FROM Tenants WHERE Host = @Host AND TenantId <> @Id', { Host: body.host, Id: tenantId });
    if (clash.length) throw new AppError(409, 'host_taken', `Another organisation already uses the host "${body.host}"`);
  }

  await tenantQuery(
    tenantId,
    `UPDATE Tenants
        SET Name = COALESCE(@Name, Name),
            Host = CASE WHEN @HostGiven = 1 THEN @Host ELSE Host END,
            AdminNotifyEmail = CASE WHEN @NotifyGiven = 1 THEN @Notify ELSE AdminNotifyEmail END,
            IsActive = COALESCE(@IsActive, IsActive),
            FileStorageRoot = CASE WHEN @RootGiven = 1 THEN @Root ELSE FileStorageRoot END
      WHERE TenantId = @TenantId`,
    {
      Name: body.name ?? null,
      Host: body.host ?? null,
      HostGiven: 'host' in body ? 1 : 0,
      Notify: body.notifyEmail ?? null,
      NotifyGiven: 'notifyEmail' in body ? 1 : 0,
      IsActive: body.isActive === undefined ? null : body.isActive,
      RootGiven: fileRootGiven ? 1 : 0,
      Root: fileStorageRoot,
    },
  );
  forgetTenant();

  const changed = { ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)), ...(fileRootGiven ? { fileStorageRoot, fileStorageRootWas: before.FileStorageRoot } : {}) };
  await platformAudit(req, me.platformAdminId, {
    action: body.isActive === false ? 'tenant.suspended' : body.isActive === true ? 'tenant.reactivated' : 'tenant.updated',
    entityType: 'Tenant',
    entityId: tenantId,
    tenantId,
    detail: changed,
  });
  // the customer's own audit log records it too, so nothing done from outside is invisible inside
  await audit(tenantId, systemActor, {
    action: body.isActive === false ? 'tenant.suspended' : body.isActive === true ? 'tenant.reactivated' : 'tenant.updated',
    entityType: 'Tenant',
    entityId: tenantId,
    detail: { ...changed, changedBy: me.email },
  });

  if (body.isActive === false) {
    // a suspended customer must not keep working through sessions that are already open
    await tenantQuery(tenantId, 'UPDATE RefreshTokens SET RevokedAt = SYSUTCDATETIME() WHERE TenantId = @TenantId AND RevokedAt IS NULL');
  }

  res.json({ tenant: shape(await loadOr404(tenantId)), was: { isActive: before.IsActive } });
});

/**
 * Remove a customer. Nothing is deleted yet: it is marked removed and kept, restorable, for
 * TENANT_REMOVAL_DAYS, after which the tenant purge job (./purge.ts) deletes every row and file it owns.
 * It must be suspended first, and the caller must repeat its slug, so one mistaken click can't do it.
 */
platformTenantsRouter.delete('/:tenantId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const body = z.object({ confirmSlug: z.string().trim().min(1) }).parse(req.body ?? {});
  const me = req.platformAdmin!;
  const tenant = await loadOr404(tenantId);

  if (tenant.RemovedAt) throw new AppError(409, 'removed', 'This organisation has already been removed');
  if (tenant.IsActive) throw new AppError(409, 'not_suspended', 'Suspend this organisation before removing it');
  if (body.confirmSlug !== tenant.Slug) throw new AppError(400, 'confirm_mismatch', `Type "${tenant.Slug}" to confirm`);

  await tenantQuery(
    tenantId,
    `UPDATE Tenants SET RemovedAt = SYSUTCDATETIME(), PurgeAfter = DATEADD(DAY, @Days, SYSUTCDATETIME())
      WHERE TenantId = @TenantId AND IsActive = 0 AND RemovedAt IS NULL`,
    { Days: config.tenantRemovalDays },
  );
  const after = await loadOr404(tenantId);

  const detail = { name: tenant.Name, slug: tenant.Slug, purgeAfter: after.PurgeAfter };
  await platformAudit(req, me.platformAdminId, { action: 'tenant.removed', entityType: 'Tenant', entityId: tenantId, tenantId, detail });
  await audit(tenantId, systemActor, { action: 'tenant.removed', entityType: 'Tenant', entityId: tenantId, detail: { ...detail, changedBy: me.email } });

  res.json({ tenant: shape(after) });
});

/** Undo a removal before its data is deleted. The customer comes back suspended; reactivating is a separate step. */
platformTenantsRouter.post('/:tenantId/restore', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const me = req.platformAdmin!;
  const tenant = await loadOr404(tenantId);
  if (!tenant.RemovedAt) throw new AppError(409, 'not_removed', 'This organisation has not been removed');

  await tenantQuery(tenantId, 'UPDATE Tenants SET RemovedAt = NULL, PurgeAfter = NULL WHERE TenantId = @TenantId');

  await platformAudit(req, me.platformAdminId, { action: 'tenant.restored', entityType: 'Tenant', entityId: tenantId, tenantId, detail: { removedAt: tenant.RemovedAt } });
  await audit(tenantId, systemActor, { action: 'tenant.restored', entityType: 'Tenant', entityId: tenantId, detail: { changedBy: me.email } });

  res.json({ tenant: shape(await loadOr404(tenantId)) });
});

/**
 * Make someone an administrator of this customer (or take the role away). Adding works for anyone:
 *   - an active user gets the Admin role;
 *   - a deactivated user is reactivated and gets it;
 *   - an address with no account gets a new one (displayName required), with no key yet, and is emailed how to
 *     sign in - their first sign-in confirms the address and lets them choose a key, so nobody here learns it.
 * The customer's "allowed email domains" only limit self-registration, so they do not apply here.
 */
platformTenantsRouter.post('/:tenantId/admins', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const body = z.object({
    email: z.string().trim().email().max(320),
    displayName: z.string().trim().min(2).max(200).optional(),
    remove: z.boolean().optional(),
  }).parse(req.body);
  const me = req.platformAdmin!;
  await loadEditableOr404(tenantId);
  const email = normalizeEmail(body.email);

  if (body.remove) {
    const [user] = await tenantQuery<{ UserId: number }>(
      tenantId,
      'SELECT UserId FROM Users WHERE TenantId = @TenantId AND Email = @Email AND IsActive = 1',
      { Email: email },
    );
    if (!user) throw new AppError(404, 'not_found', 'No active user with that address in this organisation');
    await tenantQuery(tenantId, `DELETE FROM UserRoles WHERE TenantId = @TenantId AND UserId = @UserId AND Role = 'Admin'`, { UserId: user.UserId });
    await platformAudit(req, me.platformAdminId, { action: 'tenant.admin_revoked', entityType: 'User', entityId: user.UserId, tenantId, detail: { email } });
    await audit(tenantId, systemActor, { action: 'tenant.admin_revoked', entityType: 'User', entityId: user.UserId, detail: { email, changedBy: me.email } });
    return res.json({ ok: true, outcome: 'revoked' });
  }

  const result = await withTx(async (tx) => {
    const [user] = await tenantQuery<{ UserId: number; IsActive: boolean }>(
      tenantId,
      'SELECT UserId, IsActive FROM Users WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND Email = @Email',
      { Email: email },
      tx,
    );
    if (!user) {
      if (!body.displayName) {
        throw new AppError(400, 'name_required', 'This person has no account here yet: enter their full name to create one.');
      }
      const userId = await createUser(tenantId, { email, displayName: body.displayName, roles: ['Admin'], passwordHash: await unusablePasswordHash(), passwordSet: false }, tx);
      await queueAccountCreatedEmail(tenantId, { userId, email, displayName: body.displayName }, tx, { asAdministrator: true });
      return { userId, outcome: 'created' as const };
    }
    if (!user.IsActive) await tenantQuery(tenantId, 'UPDATE Users SET IsActive = 1 WHERE TenantId = @TenantId AND UserId = @UserId', { UserId: user.UserId }, tx);
    await tenantQuery(
      tenantId,
      `IF NOT EXISTS (SELECT 1 FROM UserRoles WHERE TenantId = @TenantId AND UserId = @UserId AND Role = 'Admin')
         INSERT INTO UserRoles (TenantId, UserId, Role) VALUES (@TenantId, @UserId, 'Admin')`,
      { UserId: user.UserId },
      tx,
    );
    return { userId: user.UserId, outcome: user.IsActive ? ('granted' as const) : ('reactivated' as const) };
  });

  const detail = { email, outcome: result.outcome, ...(result.outcome === 'created' ? { displayName: body.displayName } : {}) };
  await platformAudit(req, me.platformAdminId, { action: 'tenant.admin_granted', entityType: 'User', entityId: result.userId, tenantId, detail });
  await audit(tenantId, systemActor, { action: result.outcome === 'created' ? 'user.created' : 'tenant.admin_granted', entityType: 'User', entityId: result.userId, detail: { ...detail, roles: ['Admin'], changedBy: me.email } });
  res.json({ ok: true, outcome: result.outcome, userId: result.userId });
});

/**
 * Support fallback: forget a customer administrator's key so they set a new one at next sign-in,
 * with email verification. It never reveals or sets a key - a global administrator cannot sign in as
 * a customer's user from here.
 */
platformTenantsRouter.post('/:tenantId/admins/:userId/reset-key', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const userId = Number(req.params.userId);
  const me = req.platformAdmin!;
  await loadEditableOr404(tenantId);

  const done = await withTx((tx) => resetPasswordKey(tenantId, userId, tx));
  if (!done) throw new AppError(404, 'not_found', 'No such user in this organisation');

  await platformAudit(req, me.platformAdminId, { action: 'tenant.admin_key_reset', entityType: 'User', entityId: userId, tenantId });
  await audit(tenantId, systemActor, { action: 'user.key_reset', entityType: 'User', entityId: userId, detail: { changedBy: me.email } });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------------------
// Exporting a customer's PDFs (one form, a range of submitted dates) - the same export its own administrators have.
// ---------------------------------------------------------------------------------------
platformTenantsRouter.get('/:tenantId/forms', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  await loadOr404(tenantId);
  const forms = await tenantQuery<{ FormId: number; Name: string; Deleted: number }>(
    tenantId,
    'SELECT FormId, Name, CASE WHEN DeletedAt IS NULL THEN 0 ELSE 1 END AS Deleted FROM Forms WHERE TenantId = @TenantId ORDER BY Name',
  );
  res.json({ forms: forms.map((f) => ({ formId: f.FormId, name: f.Name, deleted: f.Deleted === 1 })) });
});

platformTenantsRouter.get('/:tenantId/exports/pdfs/preview', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  await loadOr404(tenantId);
  res.json(await previewExport(tenantId, exportQuery.parse(req.query)));
});

platformTenantsRouter.get('/:tenantId/exports/pdfs', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const me = req.platformAdmin!;
  await loadOr404(tenantId);
  const q = exportQuery.parse(req.query);
  const count = await sendExport(res, tenantId, q);
  if (!count) return;
  await platformAudit(req, me.platformAdminId, { action: 'tenant.pdfs_exported', entityType: 'Form', entityId: q.formId, tenantId, detail: { ...q, files: count } });
  // the customer's own audit log records it too, so nothing done from outside is invisible inside
  await audit(tenantId, systemActor, { action: 'pdf.exported', entityType: 'Form', entityId: q.formId, detail: { ...q, files: count, changedBy: me.email } });
});

// ---------------------------------------------------------------------------------------
// Per-customer settings: the same shape the customer's own administrator edits.
// ---------------------------------------------------------------------------------------
platformTenantsRouter.get('/:tenantId/settings', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  await loadOr404(tenantId);
  res.json({ settings: await settingsForApi(tenantId) });
});

platformTenantsRouter.patch('/:tenantId/settings', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const patch = settingsPatchBody.parse(req.body);
  const me = req.platformAdmin!;
  await loadEditableOr404(tenantId);

  const changed = await updateSettings(tenantId, patch);
  if (changed.length) {
    await platformAudit(req, me.platformAdminId, { action: 'tenant.settings_updated', entityType: 'Tenant', entityId: tenantId, tenantId, detail: { changed } });
    await audit(tenantId, systemActor, { action: 'settings.updated', entityType: 'Tenant', entityId: tenantId, detail: { changed, changedBy: me.email } });
  }
  res.json({ settings: await settingsForApi(tenantId), changed });
});

// ---------------------------------------------------------------------------------------
// Support access. Rather than giving the global console a way to read customer data directly
// (which would mean handlers taking a tenant id from the URL), it mints an ORDINARY customer
// token for a named administrator: every existing tenant check then applies unchanged.
// The token is short-lived, carries no refresh cookie, and stamps every audit row it produces.
// ---------------------------------------------------------------------------------------
const IMPERSONATION_MINUTES = 30;

platformTenantsRouter.post('/:tenantId/impersonate', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const body = z.object({ userId: z.number().int().positive().optional(), reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  const me = req.platformAdmin!;
  const tenant = await loadOr404(tenantId);
  if (!tenant.IsActive) throw new AppError(409, 'suspended', 'This organisation is suspended');

  // only ever an administrator of that organisation, so support access can never exceed what an admin can do
  const [user] = await tenantQuery<{ UserId: number; Email: string }>(
    tenantId,
    `SELECT TOP 1 u.UserId, u.Email
       FROM Users u JOIN UserRoles r ON r.TenantId = u.TenantId AND r.UserId = u.UserId
      WHERE u.TenantId = @TenantId AND r.Role = 'Admin' AND u.IsActive = 1 AND (@UserId IS NULL OR u.UserId = @UserId)
      ORDER BY u.UserId`,
    { UserId: body.userId ?? null },
  );
  if (!user) throw new AppError(404, 'not_found', 'That organisation has no active administrator to act as');

  await platformAudit(req, me.platformAdminId, {
    action: 'tenant.impersonation_started',
    entityType: 'User',
    entityId: user.UserId,
    tenantId,
    detail: { email: user.Email, minutes: IMPERSONATION_MINUTES, reason: body.reason ?? null },
  });
  await audit(tenantId, systemActor, {
    action: 'user.impersonation_started',
    entityType: 'User',
    entityId: user.UserId,
    detail: { email: user.Email, by: me.email, minutes: IMPERSONATION_MINUTES, reason: body.reason ?? null },
  });

  res.json({
    accessToken: signAccessToken({ userId: user.UserId, tenantId, impersonatedBy: me.platformAdminId }, IMPERSONATION_MINUTES),
    expiresInMinutes: IMPERSONATION_MINUTES,
    actingAs: { userId: user.UserId, email: user.Email },
    url: tenantBaseUrl({ slug: tenant.Slug, host: tenant.Host }),
  });
});

// ---------------------------------------------------------------------------------------
// One number per thing the operator cares about, across every customer.
// ---------------------------------------------------------------------------------------
export const platformStatsRouter = Router();

platformStatsRouter.get('/', async (_req, res) => {
  const [totals] = await unscopedQuery<Record<string, number>>(`
    SELECT (SELECT COUNT(*) FROM Tenants) AS Tenants,
           (SELECT COUNT(*) FROM Tenants WHERE IsActive = 1) AS ActiveTenants,
           (SELECT COUNT(*) FROM Users WHERE IsActive = 1) AS Users,
           (SELECT COUNT(*) FROM Requests) AS Requests,
           (SELECT COUNT(*) FROM Requests WHERE Status = 'InProgress') AS OpenRequests,
           (SELECT COUNT(*) FROM Notifications WHERE Status = 'Failed') AS FailedEmails,
           (SELECT COUNT(*) FROM Notifications WHERE Status = 'Queued') AS QueuedEmails`);

  const recent = await unscopedQuery<Record<string, unknown>>(`
    SELECT TOP 100 p.CreatedAt, p.Action, p.EntityType, p.EntityId, p.TenantId, -- the console's Activity tab
           -- a removed customer is gone from Tenants; its name survives in the tenant.deleted entry
           COALESCE(t.Name, (SELECT TOP 1 JSON_VALUE(d.DetailJson, '$.name') FROM PlatformAuditLog d
                              WHERE d.TenantId = p.TenantId AND d.Action = 'tenant.deleted')) AS TenantName,
           a.Email AS AdminEmail
      FROM PlatformAuditLog p
      LEFT JOIN Tenants t ON t.TenantId = p.TenantId
      LEFT JOIN PlatformAdmins a ON a.PlatformAdminId = p.PlatformAdminId
     ORDER BY p.PlatformAuditId DESC`);

  res.json({
    totals: {
      tenants: totals.Tenants,
      activeTenants: totals.ActiveTenants,
      users: totals.Users,
      requests: totals.Requests,
      openRequests: totals.OpenRequests,
      failedEmails: totals.FailedEmails,
      queuedEmails: totals.QueuedEmails,
    },
    recentActivity: recent.map((r) => ({
      at: r.CreatedAt,
      action: r.Action,
      entityType: r.EntityType,
      entityId: r.EntityId,
      tenantId: r.TenantId,
      tenantName: r.TenantName,
      by: r.AdminEmail,
    })),
  });
});
