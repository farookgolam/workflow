import ExcelJS from 'exceljs';
import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom, audit } from '../audit/audit';
import type { Role } from '../auth/middleware';
import { unusablePasswordHash } from '../auth/password';
import { assertDomainAllowed, resetPasswordKey } from '../auth/signup';
import { tenantQuery, withTx, type Tx } from '../db/query';
import { AppError } from '../http/errors';
import { LIMITS as SHEET_LIMITS, parseWorkbook } from '../lookups/service';
import { createUser, normalizeEmail, queueAccountCreatedEmail } from '../users/service';
import { idParam } from '../workflow/routes';

// Mounted behind requireAuth + requireRole('Admin').
// People can register themselves at first sign-in (auth/signup.ts) and start as Submitters. Administrators can
// also add people - one at a time or from an Excel sheet - with their roles. Either way the account has no
// password key until its owner signs in, verifies their email and creates one, so an administrator never
// knows anyone's key. Admins also grant roles, deactivate leavers, and reset a forgotten password key.
export const adminUsersRouter = Router();

const ROLES: Role[] = ['Admin', 'Approver', 'Submitter'];
const MAX_IMPORT_ROWS = 1000;

/** "Approver, Admin" -> ['Approver','Admin']; empty -> ['Submitter']. Null when a word is not a role. */
function parseRoles(text: string): Role[] | null {
  const words = text.split(/[,;/]+|\s+and\s+/i).map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (words.length === 0) return ['Submitter'];
  const roles = words.map((w) => ROLES.find((r) => r.toLowerCase() === w || `${r.toLowerCase()}s` === w));
  return roles.every(Boolean) ? [...new Set(roles as Role[])] : null;
}

/** Creates one account with no key yet, and emails its owner how to sign in. */
async function addUser(req: Request, input: { email: string; displayName: string; roles: Role[]; sendEmail: boolean }, tx: Tx): Promise<number> {
  const { tenantId } = req.user!;
  const userId = await createUser(tenantId, { email: input.email, displayName: input.displayName, roles: input.roles, passwordHash: await unusablePasswordHash(), passwordSet: false }, tx);
  await audit(tenantId, actorFrom(req), { action: 'user.created', entityType: 'User', entityId: userId, detail: { email: input.email, roles: input.roles } }, tx);
  if (input.sendEmail) await queueAccountCreatedEmail(tenantId, { userId, email: input.email, displayName: input.displayName }, tx);
  return userId;
}

const createBody = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().min(2).max(200),
  roles: z.array(z.enum(['Admin', 'Approver', 'Submitter'])).min(1),
  sendEmail: z.boolean().default(true),
});

/** Add one person. */
adminUsersRouter.post('/', async (req, res) => {
  const body = createBody.parse(req.body);
  const email = normalizeEmail(body.email);
  await assertDomainAllowed(req.user!.tenantId, email);
  const userId = await withTx((tx) => addUser(req, { ...body, email }, tx));
  res.status(201).json({ userId });
});

/** An empty sheet with the right headings, to fill in and import. */
adminUsersRouter.get('/import-template', async (_req, res) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Users');
  ws.columns = [{ header: 'Email', width: 34 }, { header: 'Name', width: 28 }, { header: 'Roles', width: 26 }];
  ws.getRow(1).font = { bold: true };
  ws.addRow(['jane.doe@example.com', 'Jane Doe', 'Approver']);
  ws.addRow(['john.smith@example.com', 'John Smith', 'Submitter']);
  ws.addRow(['pat.lee@example.com', 'Pat Lee', 'Approver, Admin']);
  const notes = wb.addWorksheet('How to fill it in');
  notes.getColumn(1).width = 100;
  for (const line of [
    'One person per row on the "Users" sheet. Replace the example rows with your own.',
    'Email - required. Their work email address.',
    'Name - required. How their name is shown.',
    'Roles - Submitter, Approver or Admin; several separated by commas (e.g. "Approver, Admin"). Leave empty for Submitter.',
    'People already in the list are skipped. Nobody gets a password key from you: each person chooses their own at first sign-in.',
  ]) notes.addRow([line]);
  // the import reads the first non-empty visible sheet: keep "Users" first
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="users-import-template.xlsx"');
  res.end(Buffer.from(await wb.xlsx.writeBuffer()));
});

type ImportRow = { row: number; email: string; displayName: string; roles: Role[]; status: 'add' | 'added' | 'exists' | 'error'; message?: string };

/**
 * Bulk add from an .xlsx sheet with the headings Email, Name and Roles (in any order, any case).
 * ?dryRun=1 only checks and reports what would happen, row by row; without it the valid new rows are added
 * in one transaction and rows for people who already exist are skipped.
 */
adminUsersRouter.post(
  '/import',
  express.raw({ type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], limit: SHEET_LIMITS.bytes }),
  async (req, res) => {
    const { tenantId } = req.user!;
    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    const sendEmail = req.query.sendEmail !== '0';
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new AppError(400, 'empty_file', 'No file was received.');
    const sheet = await parseWorkbook(req.body);

    const find = (...names: string[]) => sheet.columns.find((c) => names.includes(c.toLowerCase().replace(/[\s_-]+/g, '')));
    const emailCol = find('email', 'emailaddress', 'workemail');
    const nameCol = find('name', 'displayname', 'fullname');
    const rolesCol = find('roles', 'role');
    if (!emailCol || !nameCol) throw new AppError(400, 'bad_headings', 'The first row must have the headings Email and Name (and optionally Roles). Download the template to start from.');
    if (sheet.rows.length > MAX_IMPORT_ROWS) throw new AppError(400, 'too_many_rows', `At most ${MAX_IMPORT_ROWS} people can be imported at once.`);

    const existing = new Set(
      (await tenantQuery<{ Email: string }>(tenantId, 'SELECT Email FROM Users WHERE TenantId = @TenantId')).map((u) => u.Email),
    );
    const seen = new Set<string>();
    const rows: ImportRow[] = [];
    for (const [i, r] of sheet.rows.entries()) {
      const email = normalizeEmail(r[emailCol] ?? '');
      const displayName = (r[nameCol] ?? '').trim().slice(0, 200);
      const roles = parseRoles(rolesCol ? r[rolesCol] ?? '' : '');
      const row: ImportRow = { row: i + 2, email, displayName, roles: roles ?? [], status: 'add' };
      if (!z.string().email().max(320).safeParse(email).success) Object.assign(row, { status: 'error', message: 'Not a valid email address' });
      else if (displayName.length < 2) Object.assign(row, { status: 'error', message: 'Name is missing' });
      else if (!roles) Object.assign(row, { status: 'error', message: `Unknown role in "${r[rolesCol!]}" - use Submitter, Approver or Admin` });
      else if (seen.has(email)) Object.assign(row, { status: 'error', message: 'This email is on the sheet more than once' });
      else if (existing.has(email)) Object.assign(row, { status: 'exists', message: 'Already a user - skipped' });
      else {
        try {
          await assertDomainAllowed(tenantId, email);
        } catch (e) {
          Object.assign(row, { status: 'error', message: (e as AppError).message });
        }
      }
      seen.add(email);
      rows.push(row);
    }

    const toAdd = rows.filter((r) => r.status === 'add');
    if (!dryRun && toAdd.length) {
      await withTx(async (tx) => {
        for (const r of toAdd) await addUser(req, { email: r.email, displayName: r.displayName, roles: r.roles, sendEmail }, tx);
        await audit(tenantId, actorFrom(req), { action: 'users.imported', entityType: 'User', detail: { added: toAdd.length, skipped: rows.length - toAdd.length } }, tx);
      });
      for (const r of toAdd) r.status = 'added';
    }
    res.json({
      dryRun,
      warnings: sheet.warnings,
      summary: { rows: rows.length, add: dryRun ? toAdd.length : 0, added: dryRun ? 0 : toAdd.length, exists: rows.filter((r) => r.status === 'exists').length, errors: rows.filter((r) => r.status === 'error').length },
      rows,
    });
  },
);

adminUsersRouter.get('/', async (req, res) => {
  const rows = await tenantQuery<{ UserId: number; Email: string; DisplayName: string; IsActive: boolean; Roles: string | null }>(
    req.user!.tenantId,
    `SELECT u.UserId, u.Email, u.DisplayName, u.IsActive, CASE WHEN u.PasswordSetAt IS NULL THEN 0 ELSE 1 END AS HasKey,
            CASE WHEN u.LockedUntil > SYSUTCDATETIME() THEN 1 ELSE 0 END AS Locked, u.CreatedAt, u.EmailDigest,
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
      // the person's own choice (My account): one summary each morning instead of an email per request
      emailDigest: !!(r as unknown as { EmailDigest: boolean }).EmailDigest,
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
