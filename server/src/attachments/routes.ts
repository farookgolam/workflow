// Documents an approver attaches to their step (migration 024). Every step allows them; the per-step
// ApprovalSteps.AllowAttachments setting of 024 is no longer used.
//
// The file travels as the raw request body (application/octet-stream) with its name in ?name=, like the
// lookup import. Who may do what:
//   add / remove  the approver (or delegate) of that step, while the step is open - removal is re-checked by
//                 the table's trigger, so a decided step's files cannot go even by a direct DELETE
//   download      an administrator; or an approver of the request whose own step is at or after the one the
//                 file belongs to (an approver sees earlier steps, never later ones). Never the submitter.
import crypto from 'node:crypto';
import path from 'node:path';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFrom, audit } from '../audit/audit';
import { tenantQuery, withTx, type Tx } from '../db/query';
import { AppError } from '../http/errors';
import { dayFolder, fileRootFor, readCustomerFile, removeCustomerFile, writeCustomerFile } from '../customer-files/files';
import { idParam } from '../workflow/routes';

export const ATTACHMENT_LIMITS = { bytes: 10 * 1024 * 1024, perStep: 10 };

const OLE = [0xd0, 0xcf, 0x11, 0xe0]; // .doc .xls .ppt
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // .docx .xlsx .pptx
const TYPES: Record<string, { type: string; magic?: number[] }> = {
  pdf: { type: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  doc: { type: 'application/msword', magic: OLE },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: ZIP },
  xls: { type: 'application/vnd.ms-excel', magic: OLE },
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: ZIP },
  ppt: { type: 'application/vnd.ms-powerpoint', magic: OLE },
  pptx: { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: ZIP },
  txt: { type: 'text/plain' },
  csv: { type: 'text/csv' },
  jpg: { type: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  jpeg: { type: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  png: { type: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
};
export const ALLOWED_EXTENSIONS = Object.keys(TYPES);

/**
 * The type is decided here from the extension - never taken from the browser - and the first bytes must
 * match it, so a renamed program cannot pass as a PDF. Text files must not contain NUL bytes.
 */
function checkFile(rawName: string, content: Buffer): { fileName: string; contentType: string } {
  // eslint-disable-next-line no-control-regex
  const fileName = path.basename(rawName.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 200);
  const ext = path.extname(fileName).slice(1).toLowerCase();
  const kind = TYPES[ext];
  if (!fileName || !kind) {
    throw new AppError(400, 'file_type', `That type of file cannot be attached. Allowed: ${ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(', ')}`);
  }
  const ok = kind.magic ? kind.magic.every((b, i) => content[i] === b) : !content.subarray(0, 8192).includes(0);
  if (!ok) throw new AppError(400, 'file_content', `"${fileName}" does not look like a .${ext} file`);
  return { fileName, contentType: kind.type };
}

const rawFile = express.raw({ type: 'application/octet-stream', limit: ATTACHMENT_LIMITS.bytes });
const uploadQuery = z.object({ name: z.string().trim().min(1).max(260) });

/** The step, locked for the rest of the transaction, if this person can act on it now. */
async function openStepFor(tenantId: number, userId: number, requestStepId: number, tx: Tx) {
  const [owner] = await tenantQuery<{ RequestId: number }>(
    tenantId,
    'SELECT RequestId FROM RequestSteps WHERE TenantId = @TenantId AND RequestStepId = @RequestStepId',
    { RequestStepId: requestStepId },
    tx,
  );
  if (!owner) throw new AppError(404, 'not_found', 'Approval step not found');
  // the same lock a decision takes, so a file can't be added or removed while the step is being decided
  await tenantQuery(tenantId, 'SELECT RequestId FROM Requests WITH (UPDLOCK, ROWLOCK) WHERE TenantId = @TenantId AND RequestId = @RequestId', { RequestId: owner.RequestId }, tx);
  const [s] = await tenantQuery<{ RequestId: number; RequestStatus: string; StepStatus: string; AssignedUserId: number; DelegateUserId: number | null }>(
    tenantId,
    `SELECT rs.RequestId, r.Status AS RequestStatus, rs.Status AS StepStatus, rs.AssignedUserId, rs.DelegateUserId
       FROM RequestSteps rs
       JOIN Requests r ON r.TenantId = rs.TenantId AND r.RequestId = rs.RequestId
      WHERE rs.TenantId = @TenantId AND rs.RequestStepId = @RequestStepId`,
    { RequestStepId: requestStepId },
    tx,
  );
  if (!s || (userId !== s.AssignedUserId && userId !== s.DelegateUserId)) throw new AppError(404, 'not_found', 'Approval step not found');
  if (s.RequestStatus !== 'InProgress' || s.StepStatus !== 'Active') throw new AppError(409, 'step_closed', 'This step has already been decided');
  return s;
}

/** Mounted at /approvals (behind requireAuth), before the approvals router. */
export const approverAttachmentsRouter = Router();

approverAttachmentsRouter.post('/:requestStepId/attachments', rawFile, async (req, res) => {
  const u = req.user!;
  const requestStepId = idParam(req.params.requestStepId);
  const { name } = uploadQuery.parse(req.query);
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new AppError(400, 'empty_file', 'No file was received.');
  const content: Buffer = req.body;
  const { fileName, contentType } = checkFile(name, content);

  // a customer with its own file folder: the file goes there (written first, removed again if the rest fails)
  const root = await fileRootFor(u.tenantId);
  let onDisk: { filePath: string; sha: Buffer } | null = null;
  if (root) {
    const [where] = await tenantQuery<{ RequestNumber: string; SubmittedAt: Date; StepOrder: number }>(
      u.tenantId,
      `SELECT r.RequestNumber, r.SubmittedAt, rs.StepOrder FROM RequestSteps rs JOIN Requests r ON r.TenantId = rs.TenantId AND r.RequestId = rs.RequestId
        WHERE rs.TenantId = @TenantId AND rs.RequestStepId = @RequestStepId`,
      { RequestStepId: requestStepId },
    );
    if (!where) throw new AppError(404, 'not_found', 'Approval step not found');
    // in the folder of the day the request was submitted, beside its PDF; the name says whose it is
    onDisk = await writeCustomerFile(root, [dayFolder(where.SubmittedAt)], `${where.RequestNumber}_Step-${where.StepOrder}_${fileName}`, content);
  }

  let attachmentId: number;
  try {
    attachmentId = await withTx(async (tx) => {
      const step = await openStepFor(u.tenantId, u.userId, requestStepId, tx);
      const [{ n }] = await tenantQuery<{ n: number }>(u.tenantId, 'SELECT COUNT(*) AS n FROM StepAttachments WHERE TenantId = @TenantId AND RequestStepId = @RequestStepId', { RequestStepId: requestStepId }, tx);
      if (n >= ATTACHMENT_LIMITS.perStep) throw new AppError(409, 'too_many_files', `A step can have at most ${ATTACHMENT_LIMITS.perStep} attachments`);

      const [row] = await tenantQuery<{ AttachmentId: number }>(
        u.tenantId,
        `INSERT INTO StepAttachments (TenantId, RequestId, RequestStepId, FileName, ContentType, SizeBytes, Sha256, Content, FilePath, UploadedByUserId)
         OUTPUT inserted.AttachmentId
         VALUES (@TenantId, @RequestId, @RequestStepId, @File, @Type, @Size, @Sha, CAST(@Content AS VARBINARY(MAX)), @Path, @UserId)`, // a NULL is bound as text
        {
          RequestId: step.RequestId,
          RequestStepId: requestStepId,
          File: fileName,
          Type: contentType,
          Size: content.length,
          Sha: crypto.createHash('sha256').update(content).digest(),
          Content: onDisk ? null : content,
          Path: onDisk?.filePath ?? null,
          UserId: u.userId,
        },
        tx,
      );
      const id = Number(row.AttachmentId);
      await audit(u.tenantId, actorFrom(req), {
        action: 'attachment.added',
        entityType: 'StepAttachment',
        entityId: id,
        requestId: step.RequestId,
        detail: { requestStepId, fileName, sizeBytes: content.length, ...(onDisk ? { path: onDisk.filePath } : {}) },
      }, tx);
      return id;
    });
  } catch (err) {
    if (onDisk) await removeCustomerFile(onDisk.filePath, root);
    throw err;
  }

  res.status(201).json({ attachment: { attachmentId, fileName, contentType, sizeBytes: content.length } });
});

approverAttachmentsRouter.delete('/:requestStepId/attachments/:attachmentId', async (req, res) => {
  const u = req.user!;
  const requestStepId = idParam(req.params.requestStepId);
  const attachmentId = idParam(req.params.attachmentId);

  const removed = await withTx(async (tx) => {
    const step = await openStepFor(u.tenantId, u.userId, requestStepId, tx);
    const [a] = await tenantQuery<{ FileName: string; FilePath: string | null }>(
      u.tenantId,
      'SELECT FileName, FilePath FROM StepAttachments WHERE TenantId = @TenantId AND AttachmentId = @Id AND RequestStepId = @RequestStepId',
      { Id: attachmentId, RequestStepId: requestStepId },
      tx,
    );
    if (!a) throw new AppError(404, 'not_found', 'Attachment not found');
    await tenantQuery(u.tenantId, 'DELETE FROM StepAttachments WHERE TenantId = @TenantId AND AttachmentId = @Id', { Id: attachmentId }, tx);
    await audit(u.tenantId, actorFrom(req), {
      action: 'attachment.removed',
      entityType: 'StepAttachment',
      entityId: attachmentId,
      requestId: step.RequestId,
      detail: { requestStepId, fileName: a.FileName },
    }, tx);
    return a;
  });
  // the row is gone for good: now its file in the customer's folder, if it had one
  if (removed.FilePath) await removeCustomerFile(removed.FilePath, await fileRootFor(u.tenantId));
  res.status(204).end();
});

async function sendAttachment(req: Request, res: Response, requestId: number, attachmentId: number, approver?: number): Promise<void> {
  const { tenantId } = req.user!;
  const [a] = await tenantQuery<{ FileName: string; ContentType: string; Content: Buffer | null; FilePath: string | null; Sha256: Buffer; Allowed: number }>(
    tenantId,
    `SELECT a.FileName, a.ContentType, a.Content, a.FilePath, a.Sha256,
            CASE WHEN @Approver IS NULL THEN 1
                 WHEN EXISTS (SELECT 1 FROM RequestSteps mine
                               WHERE mine.TenantId = a.TenantId AND mine.RequestId = a.RequestId AND mine.StepOrder >= s.StepOrder
                                 AND (mine.AssignedUserId = @Approver OR mine.DelegateUserId = @Approver OR mine.ActedByUserId = @Approver)) THEN 1
                 ELSE 0 END AS Allowed
       FROM StepAttachments a
       JOIN RequestSteps s ON s.TenantId = a.TenantId AND s.RequestStepId = a.RequestStepId
      WHERE a.TenantId = @TenantId AND a.AttachmentId = @Id AND a.RequestId = @RequestId`,
    { Id: attachmentId, RequestId: requestId, Approver: approver ?? null },
  );
  if (!a || a.Allowed !== 1) throw new AppError(404, 'not_found', 'Attachment not found');
  const content = a.FilePath ? await readCustomerFile(a.FilePath, a.Sha256) : a.Content!;

  await audit(tenantId, actorFrom(req), { action: 'attachment.downloaded', entityType: 'StepAttachment', entityId: attachmentId, requestId, detail: { fileName: a.FileName } });
  const ascii = a.FileName.replace(/[^\w. -]/g, '_');
  res.setHeader('Content-Type', a.ContentType);
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.FileName)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(content);
}

approverAttachmentsRouter.get('/requests/:id/attachments/:attachmentId', (req, res) =>
  sendAttachment(req, res, idParam(req.params.id), idParam(req.params.attachmentId), req.user!.userId));

/** Mounted at /admin/requests (behind requireAuth + Admin). */
export const adminAttachmentsRouter = Router();
adminAttachmentsRouter.get('/:id/attachments/:attachmentId', (req, res) =>
  sendAttachment(req, res, idParam(req.params.id), idParam(req.params.attachmentId)));
