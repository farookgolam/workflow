import { Router, type Request, type Response } from 'express';
import { actorFrom, audit } from '../audit/audit';
import { tenantQuery } from '../db/query';
import { AppError } from '../http/errors';
import { idParam } from '../workflow/routes';
import { loadDocument } from './worker';

/**
 * Sends the PDF kept in the database.
 * `onlyFor` limits it to a request this person submitted, or took part in as an approver or delegate.
 */
async function sendPdf(req: Request, res: Response, requestId: number, onlyFor?: { submitter?: number; approver?: number }): Promise<void> {
  const { tenantId } = req.user!;
  const [r] = await tenantQuery<{ SubmitterUserId: number; Status: string; Took: number }>(
    tenantId,
    `SELECT r.SubmitterUserId, r.Status,
            CASE WHEN EXISTS (SELECT 1 FROM RequestSteps s WHERE s.TenantId = r.TenantId AND s.RequestId = r.RequestId
                               AND @Approver IS NOT NULL AND (s.AssignedUserId = @Approver OR s.DelegateUserId = @Approver OR s.ActedByUserId = @Approver))
                 THEN 1 ELSE 0 END AS Took
       FROM Requests r WHERE r.TenantId = @TenantId AND r.RequestId = @RequestId`,
    { RequestId: requestId, Approver: onlyFor?.approver ?? null },
  );
  const allowed = r && (!onlyFor || (onlyFor.submitter !== undefined && r.SubmitterUserId === onlyFor.submitter) || (onlyFor.approver !== undefined && r.Took === 1));
  if (!allowed) throw new AppError(404, 'not_found', 'Request not found');
  const doc = await loadDocument(tenantId, requestId);
  if (!doc) throw new AppError(409, 'pdf_not_ready', 'The PDF has not been generated yet. Please try again in a moment.');

  await audit(tenantId, actorFrom(req), { action: 'pdf.downloaded', entityType: 'Request', entityId: requestId, requestId });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.fileName.replace(/[^\w.-]/g, '_')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(doc.content);
}

/** Mounted at /my (behind requireAuth): submitters can only fetch PDFs of their own requests. */
export const myPdfRouter = Router();
myPdfRouter.get('/requests/:id/pdf', (req, res) => sendPdf(req, res, idParam(req.params.id), { submitter: req.user!.userId }));

/** Mounted at /approvals (behind requireAuth): an approver or delegate, for requests they had a step in. */
export const approverPdfRouter = Router();
approverPdfRouter.get('/requests/:id/pdf', (req, res) => sendPdf(req, res, idParam(req.params.id), { approver: req.user!.userId }));

/** Mounted at /admin/requests (behind requireAuth + Admin). */
export const adminArchiveRouter = Router();
adminArchiveRouter.get('/:id/pdf', (req, res) => sendPdf(req, res, idParam(req.params.id)));
