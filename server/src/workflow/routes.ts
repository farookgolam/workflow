import { Router } from 'express';
import { z } from 'zod';
import { actorFrom, audit } from '../audit/audit';
import { requireRole } from '../auth/middleware';
import { hashOpaqueToken } from '../auth/tokens';
import { tenantQuery } from '../db/query';
import { getFormFields, listActiveForms } from '../forms/service';
import { AppError } from '../http/errors';
import { lookupDataForFields } from '../lookups/service';
import { firstStepHandOff, nextStepHandOff } from './approvers';
import { decideStep, submitRequest } from './engine';
import { loadRequestDetail, submitterView } from './read';

export const idParam = (raw: unknown): number => {
  const id = z.coerce.number().int().positive().max(2147483647).safeParse(raw);
  if (!id.success) throw new AppError(404, 'not_found', 'Not found');
  return id.data;
};

const values = z.record(z.string().max(100), z.unknown());

// ---- forms + submission (mounted at /forms, behind requireAuth) ----
export const formsRouter = Router();

formsRouter.get('/', async (req, res) => {
  const forms = await listActiveForms(req.user!.tenantId);
  res.json({ forms: forms.map((f) => ({ formId: f.FormId, name: f.Name, slug: f.Slug, description: f.Description })) });
});

formsRouter.get('/:formId', async (req, res) => {
  const formId = idParam(req.params.formId);
  const form = (await listActiveForms(req.user!.tenantId)).find((f) => f.FormId === formId);
  if (!form) throw new AppError(404, 'not_found', 'Form not found');
  const fields = await getFormFields(req.user!.tenantId, formId);
  const firstStep = await firstStepHandOff(req.user!.tenantId, formId, req.user!.userId);
  res.json({
    form: { formId, name: form.Name, slug: form.Slug, description: form.Description },
    fields: fields.map(({ key, label, type, required, options, rules, props }) => ({ key, label, type, required, options, rules, props })),
    lookups: await lookupDataForFields(req.user!.tenantId, fields),
    // who the request goes to first: the fixed approver, or the people the submitter chooses from
    firstStep,
  });
});

formsRouter.post('/:formId/requests', requireRole('Submitter'), async (req, res) => {
  const body = z.object({ values, firstApproverUserId: z.number().int().positive().max(2147483647).optional(), firstApproverKey: z.string().min(1).max(400).optional() }).parse(req.body);
  const u = req.user!;
  const created = await submitRequest(
    u.tenantId,
    actorFrom(req),
    { userId: u.userId, email: u.email, displayName: u.displayName },
    idParam(req.params.formId),
    body.values,
    body.firstApproverKey !== undefined ? { listKey: body.firstApproverKey } : body.firstApproverUserId,
  );
  res.status(201).json(created);
});

// ---- submitter's own requests (mounted at /my, behind requireAuth). Full portal arrives in Phase 6. ----
export const myRouter = Router();

// "My submissions". The submitter id always comes from the session - there is no way to ask for anyone else's.
myRouter.get('/requests', async (req, res) => {
  const q = z
    .object({
      status: z.enum(['InProgress', 'Approved', 'Rejected', 'Cancelled']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(25),
    })
    .parse(req.query);
  const rows = await tenantQuery<Record<string, any>>(
    req.user!.tenantId,
    `SELECT r.RequestId, r.RequestNumber, r.FormId, f.Name AS FormName, r.Status, r.CurrentStepOrder, r.TotalSteps, r.SubmittedAt, r.ClosedAt,
            rs.StepName AS CurrentStepName, u.DisplayName AS WaitingOn, r.RejectionReason, rj.StepOrder AS RejectedStepOrder, rj.StepName AS RejectedStepName,
            CASE WHEN EXISTS (SELECT 1 FROM RequestDocuments d WHERE d.TenantId = r.TenantId AND d.RequestId = r.RequestId) OR r.PdfLocalPath IS NOT NULL THEN 1 ELSE 0 END AS PdfAvailable, COUNT(*) OVER () AS Total
       FROM Requests r
       JOIN Forms f ON f.TenantId = r.TenantId AND f.FormId = r.FormId
       LEFT JOIN RequestSteps rs ON rs.TenantId = r.TenantId AND rs.RequestId = r.RequestId AND rs.Status = 'Active'
       LEFT JOIN Users u ON u.TenantId = rs.TenantId AND u.UserId = rs.AssignedUserId
       LEFT JOIN RequestSteps rj ON rj.TenantId = r.TenantId AND rj.RequestStepId = r.RejectedRequestStepId
      WHERE r.TenantId = @TenantId AND r.SubmitterUserId = @UserId AND (@Status IS NULL OR r.Status = @Status)
      ORDER BY r.SubmittedAt DESC, r.RequestId DESC
      OFFSET @Offset ROWS FETCH NEXT @Size ROWS ONLY`,
    { UserId: req.user!.userId, Status: q.status ?? null, Offset: (q.page - 1) * q.pageSize, Size: q.pageSize },
  );
  res.json({
    total: rows[0]?.Total ?? 0,
    page: q.page,
    pageSize: q.pageSize,
    requests: rows.map((r) => ({
      requestId: r.RequestId,
      requestNumber: r.RequestNumber,
      formId: r.FormId,
      formName: r.FormName,
      status: r.Status,
      currentStep: r.CurrentStepOrder,
      currentStepName: r.CurrentStepName,
      totalSteps: r.TotalSteps,
      waitingOn: r.WaitingOn,
      submittedAt: r.SubmittedAt,
      closedAt: r.ClosedAt,
      rejection: r.Status === 'Rejected' ? { reason: r.RejectionReason, stepOrder: r.RejectedStepOrder, stepName: r.RejectedStepName } : null,
      pdfAvailable: r.PdfAvailable === 1,
    })),
  });
});

myRouter.get('/requests/:id', async (req, res) => {
  const detail = await loadRequestDetail(req.user!.tenantId, idParam(req.params.id));
  // someone else's request looks exactly like a missing one
  if (!detail || detail.submitterUserId !== req.user!.userId) throw new AppError(404, 'not_found', 'Request not found');
  res.json({ request: submitterView(detail) });
});

// ---- approver page + decision (mounted at /approvals, behind requireAuth) ----
export const approvalsRouter = Router();
approvalsRouter.use(requireRole('Approver', 'Admin'));

/**
 * Exchanges the emailed link token for the step it points at. The caller must already be
 * signed in, and the token must have been issued to that same user: a forwarded or leaked
 * link is useless to anyone else. A consumed token still resolves, so the approver can
 * revisit their (now read-only) decision from the same email.
 */
approvalsRouter.get('/resolve', async (req, res) => {
  const token = z.string().min(20).max(200).safeParse(req.query.token);
  const u = req.user!;
  const [row] = token.success
    ? await tenantQuery<{ RequestStepId: number; RequestId: number; Usable: number }>(
        u.tenantId,
        `SELECT tok.RequestStepId, rs.RequestId,
                CASE WHEN tok.RevokedAt IS NULL AND tok.ExpiresAt > SYSUTCDATETIME() THEN 1 ELSE 0 END AS Usable
           FROM ApprovalTokens tok
           JOIN RequestSteps rs ON rs.TenantId = tok.TenantId AND rs.RequestStepId = tok.RequestStepId
          WHERE tok.TenantId = @TenantId AND tok.TokenHash = @Hash AND tok.UserId = @UserId`,
        { Hash: hashOpaqueToken(token.data), UserId: u.userId },
      )
    : [];
  if (!row?.Usable) {
    throw new AppError(403, 'invalid_link', 'This approval link is invalid, has expired, or was issued to a different user. Check "My approvals" or ask an administrator to resend it.');
  }
  await audit(u.tenantId, actorFrom(req), { action: 'approval.link_opened', entityType: 'RequestStep', entityId: row.RequestStepId, requestId: row.RequestId });
  res.json({ requestStepId: row.RequestStepId });
});

approvalsRouter.get('/pending', async (req, res) => {
  const rows = await tenantQuery<Record<string, any>>(
    req.user!.tenantId,
    `SELECT rs.RequestStepId, rs.StepOrder, rs.StepName, rs.ActivatedAt, rs.DueAt, r.RequestNumber, r.TotalSteps, f.Name AS FormName, su.DisplayName AS SubmitterName
       FROM RequestSteps rs
       JOIN Requests r ON r.TenantId = rs.TenantId AND r.RequestId = rs.RequestId AND r.Status = 'InProgress'
       JOIN Forms f ON f.TenantId = r.TenantId AND f.FormId = r.FormId
       JOIN Users su ON su.TenantId = r.TenantId AND su.UserId = r.SubmitterUserId
      WHERE rs.TenantId = @TenantId AND rs.Status = 'Active' AND (rs.AssignedUserId = @UserId OR rs.DelegateUserId = @UserId)
      ORDER BY rs.ActivatedAt`,
    { UserId: req.user!.userId },
  );
  res.json({
    approvals: rows.map((r) => ({
      requestStepId: r.RequestStepId,
      requestNumber: r.RequestNumber,
      formName: r.FormName,
      submitterName: r.SubmitterName,
      stepOrder: r.StepOrder,
      totalSteps: r.TotalSteps,
      stepName: r.StepName,
      activatedAt: r.ActivatedAt,
      dueAt: r.DueAt,
      overdue: r.DueAt !== null && r.DueAt < new Date(),
    })),
  });
});

/** The approver page: (a) the submission, (b) earlier approvers' completed sections, (c) this approver's own section. */
approvalsRouter.get('/:requestStepId', async (req, res) => {
  const u = req.user!;
  const requestStepId = idParam(req.params.requestStepId);
  const [owner] = await tenantQuery<{ RequestId: number }>(
    u.tenantId,
    `SELECT RequestId FROM RequestSteps
      WHERE TenantId = @TenantId AND RequestStepId = @RequestStepId
        AND (AssignedUserId = @UserId OR DelegateUserId = @UserId OR ActedByUserId = @UserId)`,
    { RequestStepId: requestStepId, UserId: u.userId },
  );
  const detail = owner ? await loadRequestDetail(u.tenantId, owner.RequestId) : null;
  const step = detail?.steps.find((s) => s.requestStepId === requestStepId);
  if (!detail || !step) throw new AppError(404, 'not_found', 'Approval step not found');

  const canAct = detail.status === 'InProgress' && step.status === 'Active' && (step.assignedUserId === u.userId || step.delegateUserId === u.userId);
  res.json({
    request: {
      requestId: detail.requestId,
      requestNumber: detail.requestNumber,
      formName: detail.formName,
      status: detail.status,
      submitterName: detail.submitterName,
      submittedAt: detail.submittedAt,
      totalSteps: detail.totalSteps,
      rejectionReason: detail.rejectionReason,
      pdfAvailable: (await tenantQuery<{ n: number }>(u.tenantId, 'SELECT COUNT(*) AS n FROM RequestDocuments WHERE TenantId = @TenantId AND RequestId = @R', { R: detail.requestId }))[0].n > 0,
    },
    submission: detail.data,
    // only sections completed BEFORE this step - an approver never sees later steps
    previousSteps: detail.steps
      .filter((s) => s.stepOrder < step.stepOrder && (s.status === 'Approved' || s.status === 'Rejected'))
      .map((s) => ({ stepOrder: s.stepOrder, name: s.name, decision: s.status, actedBy: s.actedBy, actedAt: s.actedAt, comments: s.comments, responses: s.responses })),
    step: {
      requestStepId,
      stepOrder: step.stepOrder,
      name: step.name,
      status: step.status,
      canAct,
      dueAt: step.dueAt,
      // populated once decided
      // the step this one hands over to when approved (null on the last step)
      nextStep: canAct ? await nextStepHandOff(u.tenantId, detail.requestId, step.stepOrder, u.userId) : null,
      decided: canAct || step.status === 'Waiting' ? null : { decision: step.status, actedBy: step.actedBy, actedAt: step.actedAt, comments: step.comments, responses: step.responses },
    },
  });
});

const decisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  // approvers no longer fill in controls; an empty object is still accepted from older pages
  fields: z.object({}, { message: 'Approvers no longer fill in controls' }).strict().optional(),
  comments: z.string().max(4000).optional(),
  rejectionReason: z.string().max(2000).optional(),
  token: z.string().min(20).max(200).optional(),
  nextApproverUserId: z.number().int().positive().max(2147483647).optional(),
  nextApproverKey: z.string().min(1).max(400).optional(),
});

approvalsRouter.post('/:requestStepId/decision', async (req, res) => {
  const body = decisionBody.parse(req.body);
  const u = req.user!;
  const result = await decideStep(u.tenantId, actorFrom(req), { userId: u.userId, displayName: u.displayName }, idParam(req.params.requestStepId), body);
  res.json(result);
});
