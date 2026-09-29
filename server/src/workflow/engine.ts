// The approval state machine. Every transition runs in ONE transaction that contains the
// state change, the audit rows and the outbox emails - so they commit or roll back together.
//
//   InProgress --approve (not last)--> InProgress (next step Active)
//   InProgress --approve (last)------> Approved   (final)  -> ArchiveStatus = PdfPending
//   InProgress --reject (any step)---> Rejected   (final)  -> ArchiveStatus = PdfPending
//   InProgress --admin cancel--------> Cancelled  (final)
//   InProgress --send back-----------> InProgress (that step Returned: waiting on the submitter)
//   InProgress --resubmit------------> InProgress (the same step Active again, with the edited submission)
//
// Note: Requests and RequestSteps carry triggers, and SQL Server forbids OUTPUT (without
// INTO) on such tables - so writes to them use SCOPE_IDENTITY() / @@ROWCOUNT instead.
import { audit, type Actor } from '../audit/audit';
import { hashOpaqueToken, newOpaqueToken } from '../auth/tokens';
import { config } from '../config';
import { tenantQuery, withTx, type Tx } from '../db/query';
import { getFormFields } from '../forms/service';
import { checkSignature } from '../forms/sigpad';
import { validateValues } from '../forms/validation';
import { AppError } from '../http/errors';
import { resolveLookupRows } from '../lookups/service';
import { adminRecipients, emailBody, queueNotification, type EmailLine } from '../notifications/outbox';
import { tenantBaseUrlBySlug } from '../tenant';
import { handOverStep } from './approvers';
import { emailValue, submissionDetails } from './emailDetails';
import type { FieldChange } from './read';

interface RequestContext {
  requestId: number;
  requestNumber: string;
  formName: string;
  tenantSlug: string;
  /** This customer's portal base, e.g. https://acme.approvals.example.com - every emailed link starts here. */
  baseUrl: string;
  submitter: { userId: number; email: string; displayName: string };
}

const fmtDate = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const portalLink = (ctx: RequestContext) => `${ctx.baseUrl}/requests/${ctx.requestId}`;

async function nextRequestNumber(tenantId: number, tx: Tx): Promise<string> {
  let [row] = await tenantQuery<{ LastNumber: number }>(
    tenantId,
    'UPDATE RequestCounters SET LastNumber = LastNumber + 1 OUTPUT inserted.LastNumber WHERE TenantId = @TenantId',
    {},
    tx,
  );
  if (!row) {
    [row] = await tenantQuery<{ LastNumber: number }>(
      tenantId,
      'INSERT INTO RequestCounters (TenantId, LastNumber) OUTPUT inserted.LastNumber VALUES (@TenantId, 1)',
      {},
      tx,
    );
  }
  return `REQ-${String(row.LastNumber).padStart(6, '0')}`;
}

/** What every "please decide" email ends with: the submitted values, then Approve / Send back / Reject buttons and the plain link. */
async function decisionLines(tenantId: number, requestId: number, link: string, tx: Tx): Promise<EmailLine[]> {
  return [
    { details: await submissionDetails(tenantId, requestId, tx), title: 'Request details' },
    {
      buttons: [
        { link: `${link}&do=approve`, text: 'Approve', tone: 'ok' },
        { link: `${link}&do=return`, text: 'Send back for changes', tone: 'plain' },
        { link: `${link}&do=reject`, text: 'Reject', tone: 'bad' },
      ],
    },
    { link, text: 'Open the full request' },
    `You will be asked to sign in, and to sign on screen to approve. Nothing is decided until you confirm on that page. This link is personal to you and expires in ${config.auth.approvalTokenTtlDays} days.`,
  ];
}

/** "Amount: 100.00 → 120.00" rows for the approver, in the email's words. */
const changeRows = (changes: FieldChange[]) =>
  changes.map((c) => ({ label: c.label, value: `${emailValue(c.type, c.from) ?? '(empty)'} → ${emailValue(c.type, c.to) ?? '(empty)'}` }));

/**
 * Waiting -> Active for one step (or Returned -> Active when the submitter resubmits after a send-back): sets the
 * clock, issues the approver's link token, queues their email.
 */
async function activateStep(
  tenantId: number, actor: Actor, ctx: RequestContext, stepOrder: number, tx: Tx,
  resubmitted?: { changes: FieldChange[]; note: string | null },
): Promise<void> {
  const from = resubmitted ? 'Returned' : 'Waiting';
  const [{ n }] = await tenantQuery<{ n: number }>(
    tenantId,
    `UPDATE rs SET Status = 'Active', ActivatedAt = SYSUTCDATETIME(), LastReminderAt = NULL, ReminderCount = 0, EscalatedAt = NULL,
            DueAt = CASE WHEN COALESCE(s.ReminderAfterDays, s.EscalateAfterDays) IS NULL THEN NULL
                         ELSE DATEADD(DAY, COALESCE(s.ReminderAfterDays, s.EscalateAfterDays), SYSUTCDATETIME()) END
       FROM RequestSteps rs
       JOIN ApprovalSteps s ON s.TenantId = rs.TenantId AND s.StepId = rs.StepId
      WHERE rs.TenantId = @TenantId AND rs.RequestId = @RequestId AND rs.StepOrder = @StepOrder AND rs.Status = @From;
     SELECT @@ROWCOUNT AS n;`,
    { RequestId: ctx.requestId, StepOrder: stepOrder, From: from },
    tx,
  );
  if (n !== 1) throw new Error(`activateStep: step ${stepOrder} of request ${ctx.requestId} was not ${from}`);

  const [step] = await tenantQuery<{ RequestStepId: number; StepName: string; AssignedUserId: number; Email: string; DisplayName: string }>(
    tenantId,
    `SELECT rs.RequestStepId, rs.StepName, rs.AssignedUserId, u.Email, u.DisplayName
       FROM RequestSteps rs JOIN Users u ON u.TenantId = rs.TenantId AND u.UserId = rs.AssignedUserId
      WHERE rs.TenantId = @TenantId AND rs.RequestId = @RequestId AND rs.StepOrder = @StepOrder`,
    { RequestId: ctx.requestId, StepOrder: stepOrder },
    tx,
  );
  const link = await issueApprovalLink(tenantId, ctx.tenantSlug, step.RequestStepId, step.AssignedUserId, tx);

  const intro: EmailLine[] = resubmitted
    ? [
        `${ctx.submitter.displayName} has made changes to the request you sent back, and it is waiting for your decision again at step "${step.StepName}".`,
        ...(resubmitted.changes.length ? [{ details: changeRows(resubmitted.changes), title: 'What changed' }] : ['No values were changed.']),
        ...(resubmitted.note ? [{ label: 'Their note', value: resubmitted.note }] : []),
      ]
    : [`A request is waiting for your decision at step "${step.StepName}".`];
  await queueNotification(
    tenantId,
    {
      type: resubmitted ? 'Resubmitted' : 'ApprovalRequested',
      to: { userId: step.AssignedUserId, email: step.Email },
      subject: `${resubmitted ? 'Resubmitted for approval' : 'Approval needed'}: ${ctx.formName} ${ctx.requestNumber}`,
      bodyHtml: emailBody([
        `Hello ${step.DisplayName},`,
        ...intro,
        { label: 'Form', value: ctx.formName },
        { label: 'Request', value: ctx.requestNumber },
        { label: 'Submitted by', value: ctx.submitter.displayName },
        ...(await decisionLines(tenantId, ctx.requestId, link, tx)),
      ]),
      requestId: ctx.requestId,
      requestStepId: step.RequestStepId,
    },
    tx,
  );
  await audit(
    tenantId,
    actor,
    {
      action: 'step.activated',
      entityType: 'RequestStep',
      entityId: step.RequestStepId,
      requestId: ctx.requestId,
      fromState: from,
      toState: 'Active',
      detail: { stepOrder, assignedUserId: step.AssignedUserId, selfApproval: step.AssignedUserId === ctx.submitter.userId || undefined },
    },
    tx,
  );
}

/** Issues a fresh link token bound to `userId`, superseding that user's earlier link for the step. Returns the emailed link. */
export async function issueApprovalLink(tenantId: number, tenantSlug: string, requestStepId: number, userId: number, tx: Tx): Promise<string> {
  await tenantQuery(
    tenantId,
    `UPDATE ApprovalTokens SET RevokedAt = SYSUTCDATETIME()
      WHERE TenantId = @TenantId AND RequestStepId = @RequestStepId AND UserId = @UserId AND RevokedAt IS NULL AND ConsumedAt IS NULL`,
    { RequestStepId: requestStepId, UserId: userId },
    tx,
  );
  const { raw, hash } = newOpaqueToken();
  await tenantQuery(
    tenantId,
    `INSERT INTO ApprovalTokens (TenantId, RequestStepId, UserId, TokenHash, ExpiresAt)
     VALUES (@TenantId, @RequestStepId, @UserId, @Hash, DATEADD(DAY, @Days, SYSUTCDATETIME()))`,
    { RequestStepId: requestStepId, UserId: userId, Hash: hash, Days: config.auth.approvalTokenTtlDays },
    tx,
  );
  return `${await tenantBaseUrlBySlug(tenantSlug)}/approve?token=${raw}`;
}

async function writeRequestData(tenantId: number, requestId: number, data: ReturnType<typeof validateValues>, tx: Tx): Promise<void> {
  for (const { def, value } of data) {
    await tenantQuery(
      tenantId,
      `INSERT INTO RequestData (TenantId, RequestId, FieldId, FieldKey, FieldLabel, FieldType, SortOrder, Value)
       VALUES (@TenantId, @RequestId, @FieldId, @Key, @Label, @Type, @Sort, @Value)`,
      { RequestId: requestId, FieldId: def.id, Key: def.key, Label: def.label, Type: def.type, Sort: def.sortOrder, Value: value },
      tx,
    );
  }
}

// ---------------------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------------------
export async function submitRequest(
  tenantId: number,
  actor: Actor,
  submitter: { userId: number; email: string; displayName: string },
  formId: number,
  values: Record<string, unknown>,
  /** Who the submitter picked for step 1 - a user id, or a row of the step's approver spreadsheet; the chain's approver when omitted. */
  firstApprover?: number | { listKey: string },
): Promise<{ requestId: number; requestNumber: string }> {
  return withTx(async (tx) => {
    const [form] = await tenantQuery<{ Name: string; ChainId: number | null; TenantSlug: string }>(
      tenantId,
      `SELECT f.Name, c.ChainId, t.Slug AS TenantSlug
         FROM Forms f
         JOIN Tenants t ON t.TenantId = f.TenantId
         LEFT JOIN ApprovalChains c ON c.TenantId = f.TenantId AND c.FormId = f.FormId AND c.IsCurrent = 1
        WHERE f.TenantId = @TenantId AND f.FormId = @FormId AND f.IsActive = 1 AND f.DeletedAt IS NULL`,
      { FormId: formId },
      tx,
    );
    if (!form) throw new AppError(404, 'not_found', 'Form not found');
    if (!form.ChainId) throw new AppError(409, 'no_chain', 'This form has no approval chain configured yet');

    const steps = await tenantQuery<{ StepId: number; StepOrder: number; Name: string; ApproverUserId: number; ApproverActive: boolean; ApproverChosen: boolean }>(
      tenantId,
      `SELECT s.StepId, s.StepOrder, s.Name, s.ApproverUserId, u.IsActive AS ApproverActive, s.ApproverChosen
         FROM ApprovalSteps s JOIN Users u ON u.TenantId = s.TenantId AND u.UserId = s.ApproverUserId
        WHERE s.TenantId = @TenantId AND s.ChainId = @ChainId ORDER BY s.StepOrder`,
      { ChainId: form.ChainId },
      tx,
    );
    const inactive = steps.find((s) => !s.ApproverActive && !s.ApproverChosen); // a chosen step only holds a placeholder
    if (inactive) throw new AppError(409, 'approver_inactive', `The approver for step "${inactive.Name}" is inactive; ask an administrator to update the chain`);

    const formFields = await getFormFields(tenantId, formId, tx);
    const lookupRows = await resolveLookupRows(tenantId, formFields, values, tx);
    const data = validateValues(formFields, values, { enforceRequired: true }, lookupRows);
    const requestNumber = await nextRequestNumber(tenantId, tx);

    const [{ RequestId }] = await tenantQuery<{ RequestId: number }>(
      tenantId,
      `INSERT INTO Requests (TenantId, FormId, ChainId, RequestNumber, SubmitterUserId, Status, CurrentStepOrder, TotalSteps, SubmittedIp)
       VALUES (@TenantId, @FormId, @ChainId, @Number, @Submitter, 'InProgress', 1, @Total, @Ip);
       SELECT CAST(SCOPE_IDENTITY() AS INT) AS RequestId;`,
      { FormId: formId, ChainId: form.ChainId, Number: requestNumber, Submitter: submitter.userId, Total: steps.length, Ip: actor.ip },
      tx,
    );

    await writeRequestData(tenantId, RequestId, data, tx);
    for (const s of steps) {
      await tenantQuery(
        tenantId,
        `INSERT INTO RequestSteps (TenantId, RequestId, StepId, StepOrder, StepName, AssignedUserId, Status)
         VALUES (@TenantId, @RequestId, @StepId, @Order, @Name, @Assigned, 'Waiting')`,
        { RequestId, StepId: s.StepId, Order: s.StepOrder, Name: s.Name, Assigned: s.ApproverUserId },
        tx,
      );
    }

    const ctx: RequestContext = { requestId: RequestId, requestNumber, formName: form.Name, tenantSlug: form.TenantSlug, baseUrl: await tenantBaseUrlBySlug(form.TenantSlug), submitter };
    await audit(
      tenantId,
      actor,
      { action: 'request.submitted', entityType: 'Request', entityId: RequestId, requestId: RequestId, toState: 'InProgress', detail: { formId, requestNumber, chainId: form.ChainId } },
      tx,
    );
    await queueNotification(
      tenantId,
      {
        type: 'SubmissionReceived',
        to: { userId: submitter.userId, email: submitter.email },
        subject: `We received your ${form.Name} request ${requestNumber}`,
        bodyHtml: emailBody([
          `Hello ${submitter.displayName},`,
          `Your request ${requestNumber} has been received and sent to the first approver (${steps[0].Name}). It has ${steps.length} approval step(s).`,
          { link: portalLink(ctx), text: 'Track your request' },
        ]),
        requestId: RequestId,
      },
      tx,
    );
    // step 1: its fixed approver, or the one the submitter chose
    await handOverStep(tenantId, actor, submitter.userId, RequestId, 1, firstApprover, firstApprover === undefined ? 'firstApprover' : typeof firstApprover === 'number' ? 'firstApproverUserId' : 'firstApproverKey', tx);
    await activateStep(tenantId, actor, ctx, 1, tx);
    return { requestId: RequestId, requestNumber };
  });
}

// ---------------------------------------------------------------------------------------
// decide (approve / reject)
// ---------------------------------------------------------------------------------------
export interface DecisionInput {
  /** 'return' sends the request back to the submitter for changes; the step reopens when they resubmit. */
  decision: 'approve' | 'reject' | 'return';
  comments?: string;
  rejectionReason?: string;
  /** On return (required): what the submitter should change. */
  returnReason?: string;
  /** On approve (required): the approver's drawn signature, pen strokes as from the signature pad. */
  signature?: unknown;
  /** The emailed link token, when the approver arrived through it. Verified if present. */
  token?: string;
  /** On approve: who this approver picked for the following step; the person already assigned when omitted. */
  nextApproverUserId?: number;
  /** ...or, for a step whose people come from a spreadsheet, the key of the row they picked. */
  nextApproverKey?: string;
}

export async function decideStep(
  tenantId: number,
  actor: Actor,
  user: { userId: number; displayName: string },
  requestStepId: number,
  input: DecisionInput,
): Promise<{ requestStatus: 'InProgress' | 'Approved' | 'Rejected' | 'Returned'; nextStepOrder: number | null }> {
  const reason = input.rejectionReason?.trim() ?? '';
  if (input.decision === 'reject' && !reason) {
    throw new AppError(400, 'validation_failed', 'Invalid input', [{ path: 'rejectionReason', message: 'A rejection reason is required' }]);
  }
  const returnReason = input.returnReason?.trim() ?? '';
  if (input.decision === 'return' && !returnReason) {
    throw new AppError(400, 'validation_failed', 'Invalid input', [{ path: 'returnReason', message: 'Say what needs to change' }]);
  }
  let signature: string | null = null;
  if (input.decision === 'approve') {
    const sig = input.signature === undefined ? { value: null } : checkSignature(input.signature);
    if ('error' in sig) throw new AppError(400, 'validation_failed', 'Invalid input', [{ path: 'signature', message: `Signature ${sig.error}` }]);
    if (!sig.value) throw new AppError(400, 'validation_failed', 'Invalid input', [{ path: 'signature', message: 'Sign to approve' }]);
    signature = sig.value;
  }

  return withTx(async (tx) => {
    // Lock order is always Requests -> RequestSteps. The request id is looked up in its own
    // statement so no lock on the step row is held while we wait for the request row
    // (doing both in one join deadlocks two concurrent decisions).
    const [owner] = await tenantQuery<{ RequestId: number }>(
      tenantId,
      'SELECT RequestId FROM RequestSteps WHERE TenantId = @TenantId AND RequestStepId = @RequestStepId',
      { RequestStepId: requestStepId },
      tx,
    );
    if (!owner) throw new AppError(404, 'not_found', 'Approval step not found');
    await tenantQuery(
      tenantId,
      'SELECT RequestId FROM Requests WITH (UPDLOCK, ROWLOCK) WHERE TenantId = @TenantId AND RequestId = @RequestId',
      { RequestId: owner.RequestId },
      tx,
    );
    // Concurrent decisions on the same request queue up on the lock above; everything below reads fresh state.
    const [row] = await tenantQuery<{
      RequestId: number; RequestNumber: string; RequestStatus: string; TotalSteps: number; FormName: string; TenantSlug: string;
      SubmitterUserId: number; SubmitterEmail: string; SubmitterName: string;
      StepId: number; StepOrder: number; StepName: string; StepStatus: string; AssignedUserId: number; DelegateUserId: number | null;
    }>(
      tenantId,
      `SELECT r.RequestId, r.RequestNumber, r.Status AS RequestStatus, r.TotalSteps, f.Name AS FormName, t.Slug AS TenantSlug,
              r.SubmitterUserId, su.Email AS SubmitterEmail, su.DisplayName AS SubmitterName,
              rs.StepId, rs.StepOrder, rs.StepName, rs.Status AS StepStatus, rs.AssignedUserId, rs.DelegateUserId
         FROM RequestSteps rs
         JOIN Requests r ON r.TenantId = rs.TenantId AND r.RequestId = rs.RequestId
         JOIN Forms f ON f.TenantId = r.TenantId AND f.FormId = r.FormId
         JOIN Tenants t ON t.TenantId = r.TenantId
         JOIN Users su ON su.TenantId = r.TenantId AND su.UserId = r.SubmitterUserId
        WHERE rs.TenantId = @TenantId AND rs.RequestStepId = @RequestStepId`,
      { RequestStepId: requestStepId },
      tx,
    );
    if (!row) throw new AppError(404, 'not_found', 'Approval step not found');
    // Only the assigned approver or an admin-assigned delegate. Deliberately 404, not 403:
    // other users should not learn that this step id exists.
    if (user.userId !== row.AssignedUserId && user.userId !== row.DelegateUserId) {
      throw new AppError(404, 'not_found', 'Approval step not found');
    }
    if (row.RequestStatus !== 'InProgress') throw new AppError(409, 'request_closed', `This request is ${row.RequestStatus.toLowerCase()} and can no longer be changed`);
    if (row.StepStatus !== 'Active') {
      throw new AppError(409, row.StepStatus === 'Waiting' ? 'step_not_active' : 'step_already_decided',
        row.StepStatus === 'Waiting' ? 'This step is not active yet' : 'This step has already been completed');
    }

    if (input.token !== undefined) {
      const [tok] = await tenantQuery<{ Ok: number }>(
        tenantId,
        `SELECT CASE WHEN RevokedAt IS NULL AND ConsumedAt IS NULL AND ExpiresAt > SYSUTCDATETIME() THEN 1 ELSE 0 END AS Ok
           FROM ApprovalTokens
          WHERE TenantId = @TenantId AND TokenHash = @Hash AND RequestStepId = @RequestStepId AND UserId = @UserId`,
        { Hash: hashOpaqueToken(input.token), RequestStepId: requestStepId, UserId: user.userId },
        tx,
      );
      if (!tok?.Ok) throw new AppError(403, 'invalid_link', 'This approval link is invalid, expired or belongs to someone else');
    }

    if (input.decision === 'return') {
      await sendBack(tenantId, actor, user, requestStepId, row, returnReason, input.token !== undefined, tx);
      return { requestStatus: 'Returned' as const, nextStepOrder: null };
    }

    const newStepStatus = input.decision === 'approve' ? 'Approved' : 'Rejected';

    // Guarded write: only an Active step can be decided, exactly once.
    const [{ n }] = await tenantQuery<{ n: number }>(
      tenantId,
      `UPDATE RequestSteps
          SET Status = @Status, ActedAt = SYSUTCDATETIME(), ActedByUserId = @UserId, ActedIp = @Ip, Comments = @Comments, Signature = @Signature
        WHERE TenantId = @TenantId AND RequestStepId = @RequestStepId AND Status = 'Active';
       SELECT @@ROWCOUNT AS n;`,
      { Status: newStepStatus, UserId: user.userId, Ip: actor.ip, Comments: input.comments?.trim() || null, Signature: signature, RequestStepId: requestStepId },
      tx,
    );
    if (n !== 1) throw new AppError(409, 'step_already_decided', 'This step has already been completed');

    await tenantQuery(
      tenantId,
      `UPDATE ApprovalTokens SET ConsumedAt = SYSUTCDATETIME()
        WHERE TenantId = @TenantId AND RequestStepId = @RequestStepId AND ConsumedAt IS NULL AND RevokedAt IS NULL`,
      { RequestStepId: requestStepId },
      tx,
    );
    await audit(
      tenantId,
      actor,
      {
        action: input.decision === 'approve' ? 'step.approved' : 'step.rejected',
        entityType: 'RequestStep',
        entityId: requestStepId,
        requestId: row.RequestId,
        fromState: 'Active',
        toState: newStepStatus,
        detail: {
          stepOrder: row.StepOrder,
          asDelegate: user.userId !== row.AssignedUserId || undefined,
          viaLink: input.token !== undefined,
          selfApproval: user.userId === row.SubmitterUserId || undefined,
        },
      },
      tx,
    );

    const ctx: RequestContext = {
      requestId: row.RequestId,
      requestNumber: row.RequestNumber,
      formName: row.FormName,
      tenantSlug: row.TenantSlug,
      baseUrl: await tenantBaseUrlBySlug(row.TenantSlug),
      submitter: { userId: row.SubmitterUserId, email: row.SubmitterEmail, displayName: row.SubmitterName },
    };
    const submitterTo = { userId: ctx.submitter.userId, email: ctx.submitter.email };

    if (input.decision === 'reject') {
      await tenantQuery(
        tenantId,
        `UPDATE Requests
            SET Status = 'Rejected', CurrentStepOrder = NULL, ClosedAt = SYSUTCDATETIME(),
                RejectedRequestStepId = @RequestStepId, RejectionReason = @Reason, ArchiveStatus = 'PdfPending'
          WHERE TenantId = @TenantId AND RequestId = @RequestId AND Status = 'InProgress'`,
        { RequestStepId: requestStepId, Reason: reason, RequestId: row.RequestId },
        tx,
      );
      await tenantQuery(
        tenantId,
        `UPDATE RequestSteps SET Status = 'NotReached'
          WHERE TenantId = @TenantId AND RequestId = @RequestId AND Status = 'Waiting'`,
        { RequestId: row.RequestId },
        tx,
      );
      await audit(
        tenantId,
        actor,
        { action: 'request.rejected', entityType: 'Request', entityId: row.RequestId, requestId: row.RequestId, fromState: 'InProgress', toState: 'Rejected', detail: { stepOrder: row.StepOrder, reason } },
        tx,
      );
      const facts = [
        { label: 'Request', value: `${ctx.formName} ${ctx.requestNumber}` },
        { label: 'Rejected at', value: `Step ${row.StepOrder} of ${row.TotalSteps} - ${row.StepName}` },
        { label: 'Rejected by', value: user.displayName },
        { label: 'Date', value: fmtDate(new Date()) },
        { label: 'Reason', value: reason },
      ];
      await queueNotification(
        tenantId,
        {
          type: 'Rejected',
          to: submitterTo,
          subject: `Your ${ctx.formName} request ${ctx.requestNumber} was rejected`,
          bodyHtml: emailBody([
            `Hello ${ctx.submitter.displayName},`,
            'Your request was rejected. This decision is final and the request cannot be reopened.',
            ...facts,
            'To pursue this again, please submit a new form.',
            { link: portalLink(ctx), text: 'View the request' },
          ]),
          requestId: row.RequestId,
          requestStepId,
        },
        tx,
      );
      for (const to of await adminRecipients(tenantId, tx)) {
        await queueNotification(
          tenantId,
          {
            type: 'AdminRejectedAlert',
            to,
            subject: `Rejected: ${ctx.formName} ${ctx.requestNumber}`,
            bodyHtml: emailBody(['A request was rejected.', { label: 'Submitter', value: ctx.submitter.displayName }, ...facts]),
            requestId: row.RequestId,
            requestStepId,
          },
          tx,
        );
      }
      return { requestStatus: 'Rejected' as const, nextStepOrder: null };
    }

    if (row.StepOrder < row.TotalSteps) {
      const next = row.StepOrder + 1;
      await tenantQuery(
        tenantId,
        `UPDATE Requests SET CurrentStepOrder = @Next
          WHERE TenantId = @TenantId AND RequestId = @RequestId AND Status = 'InProgress' AND CurrentStepOrder = @Current`,
        { Next: next, Current: row.StepOrder, RequestId: row.RequestId },
        tx,
      );
      // the next step: its fixed approver, or the one this approver chose
      const chosen = input.nextApproverKey !== undefined ? { listKey: input.nextApproverKey } : input.nextApproverUserId;
      await handOverStep(tenantId, actor, user.userId, row.RequestId, next, chosen, chosen === undefined ? 'nextApprover' : input.nextApproverKey !== undefined ? 'nextApproverKey' : 'nextApproverUserId', tx);
      await activateStep(tenantId, actor, ctx, next, tx);
      return { requestStatus: 'InProgress' as const, nextStepOrder: next };
    }

    await tenantQuery(
      tenantId,
      `UPDATE Requests SET Status = 'Approved', CurrentStepOrder = NULL, ClosedAt = SYSUTCDATETIME(), ArchiveStatus = 'PdfPending'
        WHERE TenantId = @TenantId AND RequestId = @RequestId AND Status = 'InProgress'`,
      { RequestId: row.RequestId },
      tx,
    );
    await audit(
      tenantId,
      actor,
      { action: 'request.approved', entityType: 'Request', entityId: row.RequestId, requestId: row.RequestId, fromState: 'InProgress', toState: 'Approved' },
      tx,
    );
    await queueNotification(
      tenantId,
      {
        type: 'FinalApproved',
        to: submitterTo,
        subject: `Your ${ctx.formName} request ${ctx.requestNumber} is fully approved`,
        bodyHtml: emailBody([
          `Hello ${ctx.submitter.displayName},`,
          `All ${row.TotalSteps} approval step(s) are complete. The final PDF will be available in the portal shortly.`,
          { link: portalLink(ctx), text: 'View the request' },
        ]),
        requestId: row.RequestId,
      },
      tx,
    );
    return { requestStatus: 'Approved' as const, nextStepOrder: null };
  });
}

// ---------------------------------------------------------------------------------------
// send back (approver) and resubmit (submitter)
// ---------------------------------------------------------------------------------------
/** Active -> Returned. Runs inside decideStep's transaction, after its checks (right user, step Active, link valid). */
async function sendBack(
  tenantId: number, actor: Actor, user: { userId: number; displayName: string }, requestStepId: number,
  row: { RequestId: number; RequestNumber: string; FormName: string; TenantSlug: string; SubmitterUserId: number; SubmitterEmail: string; SubmitterName: string; StepOrder: number; StepName: string; TotalSteps: number; AssignedUserId: number },
  reason: string, viaLink: boolean, tx: Tx,
): Promise<void> {
  const [{ n }] = await tenantQuery<{ n: number }>(
    tenantId,
    `UPDATE RequestSteps SET Status = 'Returned' WHERE TenantId = @TenantId AND RequestStepId = @S AND Status = 'Active';
     SELECT @@ROWCOUNT AS n;`,
    { S: requestStepId },
    tx,
  );
  if (n !== 1) throw new AppError(409, 'step_already_decided', 'This step has already been completed');
  // the approver gets a fresh link when it comes back
  await tenantQuery(
    tenantId,
    `UPDATE ApprovalTokens SET RevokedAt = SYSUTCDATETIME()
      WHERE TenantId = @TenantId AND RequestStepId = @S AND ConsumedAt IS NULL AND RevokedAt IS NULL`,
    { S: requestStepId },
    tx,
  );
  await tenantQuery(
    tenantId,
    `INSERT INTO RequestReturns (TenantId, RequestId, RequestStepId, StepOrder, ReturnedByUserId, Reason)
     VALUES (@TenantId, @RequestId, @S, @Order, @By, @Reason)`,
    { RequestId: row.RequestId, S: requestStepId, Order: row.StepOrder, By: user.userId, Reason: reason },
    tx,
  );
  await audit(
    tenantId,
    actor,
    {
      action: 'step.returned',
      entityType: 'RequestStep',
      entityId: requestStepId,
      requestId: row.RequestId,
      fromState: 'Active',
      toState: 'Returned',
      detail: { stepOrder: row.StepOrder, reason, asDelegate: user.userId !== row.AssignedUserId || undefined, viaLink },
    },
    tx,
  );
  const base = await tenantBaseUrlBySlug(row.TenantSlug);
  await queueNotification(
    tenantId,
    {
      type: 'SentBack',
      to: { userId: row.SubmitterUserId, email: row.SubmitterEmail },
      subject: `Changes needed: your ${row.FormName} request ${row.RequestNumber}`,
      bodyHtml: emailBody([
        `Hello ${row.SubmitterName},`,
        `${user.displayName} has sent your request back to you for changes.`,
        { label: 'Request', value: `${row.FormName} ${row.RequestNumber}` },
        { label: 'Sent back at', value: `Step ${row.StepOrder} of ${row.TotalSteps} - ${row.StepName}` },
        { label: 'What to change', value: reason },
        { buttons: [{ link: `${base}/requests/${row.RequestId}/edit`, text: 'Make the changes', tone: 'ok' }] },
        `Nothing is lost: steps already approved stay approved. When you resubmit, the request goes straight back to step ${row.StepOrder} (${row.StepName}).`,
      ]),
      requestId: row.RequestId,
      requestStepId,
    },
    tx,
  );
}

/**
 * The submitter's edited submission after a send-back: replaces the submitted values (validated exactly like a
 * new submission, against the form as it is now), records what changed, and reopens the step that sent it back.
 */
export async function resubmitRequest(
  tenantId: number,
  actor: Actor,
  submitter: { userId: number; email: string; displayName: string },
  requestId: number,
  values: Record<string, unknown>,
  note?: string,
): Promise<{ requestId: number; stepOrder: number; changes: number }> {
  return withTx(async (tx) => {
    const [r] = await tenantQuery<{ Status: string; FormId: number; RequestNumber: string; SubmitterUserId: number; FormName: string; FormDeleted: number; TenantSlug: string }>(
      tenantId,
      `SELECT r.Status, r.FormId, r.RequestNumber, r.SubmitterUserId, f.Name AS FormName,
              CASE WHEN f.DeletedAt IS NULL THEN 0 ELSE 1 END AS FormDeleted, t.Slug AS TenantSlug
         FROM Requests r WITH (UPDLOCK, ROWLOCK)
         JOIN Forms f ON f.TenantId = r.TenantId AND f.FormId = r.FormId
         JOIN Tenants t ON t.TenantId = r.TenantId
        WHERE r.TenantId = @TenantId AND r.RequestId = @RequestId`,
      { RequestId: requestId },
      tx,
    );
    // someone else's request looks exactly like a missing one
    if (!r || r.SubmitterUserId !== submitter.userId) throw new AppError(404, 'not_found', 'Request not found');
    if (r.Status !== 'InProgress') throw new AppError(409, 'request_closed', `This request is ${r.Status.toLowerCase()} and can no longer be changed`);
    const [step] = await tenantQuery<{ StepOrder: number }>(
      tenantId,
      `SELECT StepOrder FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @RequestId AND Status = 'Returned'`,
      { RequestId: requestId },
      tx,
    );
    if (!step) throw new AppError(409, 'not_returned', 'This request has not been sent back to you, so it cannot be changed');
    if (r.FormDeleted) throw new AppError(409, 'form_deleted', 'This form has been deleted, so the request cannot be resubmitted. Ask an administrator to cancel it.');

    const formFields = await getFormFields(tenantId, r.FormId, tx);
    const lookupRows = await resolveLookupRows(tenantId, formFields, values, tx);
    const data = validateValues(formFields, values, { enforceRequired: true }, lookupRows);

    const before = await tenantQuery<{ FieldKey: string; FieldLabel: string; FieldType: string; Value: string | null }>(
      tenantId,
      'SELECT FieldKey, FieldLabel, FieldType, Value FROM RequestData WHERE TenantId = @TenantId AND RequestId = @RequestId ORDER BY SortOrder',
      { RequestId: requestId },
      tx,
    );
    const empty = (v: string | null | undefined) => (v === undefined || v === '' ? null : v);
    const changes: FieldChange[] = [];
    for (const { def, value } of data) {
      const old = before.find((b) => b.FieldKey === def.key);
      if (empty(old?.Value) !== empty(value)) changes.push({ key: def.key, label: def.label, type: def.type, from: empty(old?.Value), to: empty(value) });
    }
    // a field taken off the form since: its old value is gone from the request, so say so
    for (const old of before) {
      if (!data.some((d) => d.def.key === old.FieldKey) && empty(old.Value) !== null) changes.push({ key: old.FieldKey, label: old.FieldLabel, type: old.FieldType, from: old.Value, to: null });
    }

    await tenantQuery(tenantId, 'DELETE FROM RequestData WHERE TenantId = @TenantId AND RequestId = @RequestId', { RequestId: requestId }, tx);
    await writeRequestData(tenantId, requestId, data, tx);
    const trimmedNote = note?.trim() || null;
    await tenantQuery(
      tenantId,
      `UPDATE RequestReturns SET ResubmittedAt = SYSUTCDATETIME(), ResubmitNote = @Note, ChangesJson = @Changes
        WHERE TenantId = @TenantId AND RequestId = @RequestId AND ResubmittedAt IS NULL`,
      { RequestId: requestId, Note: trimmedNote, Changes: JSON.stringify(changes) },
      tx,
    );
    await audit(
      tenantId,
      actor,
      {
        action: 'request.resubmitted',
        entityType: 'Request',
        entityId: requestId,
        requestId,
        detail: { stepOrder: step.StepOrder, changedFields: changes.map((c) => c.key) },
      },
      tx,
    );
    const ctx: RequestContext = { requestId, requestNumber: r.RequestNumber, formName: r.FormName, tenantSlug: r.TenantSlug, baseUrl: await tenantBaseUrlBySlug(r.TenantSlug), submitter };
    await activateStep(tenantId, actor, ctx, step.StepOrder, tx, { changes, note: trimmedNote });
    return { requestId, stepOrder: step.StepOrder, changes: changes.length };
  });
}

// ---------------------------------------------------------------------------------------
// cancel (admin)
// ---------------------------------------------------------------------------------------
export async function cancelRequest(tenantId: number, actor: Actor, adminUserId: number, requestId: number, reason: string): Promise<void> {
  await withTx(async (tx) => {
    const [r] = await tenantQuery<{ Status: string; RequestNumber: string; FormName: string; TenantSlug: string; SubmitterUserId: number; Email: string; DisplayName: string }>(
      tenantId,
      `SELECT r.Status, r.RequestNumber, f.Name AS FormName, t.Slug AS TenantSlug, r.SubmitterUserId, u.Email, u.DisplayName
         FROM Requests r WITH (UPDLOCK, ROWLOCK)
         JOIN Forms f ON f.TenantId = r.TenantId AND f.FormId = r.FormId
         JOIN Tenants t ON t.TenantId = r.TenantId
         JOIN Users u ON u.TenantId = r.TenantId AND u.UserId = r.SubmitterUserId
        WHERE r.TenantId = @TenantId AND r.RequestId = @RequestId`,
      { RequestId: requestId },
      tx,
    );
    if (!r) throw new AppError(404, 'not_found', 'Request not found');
    if (r.Status !== 'InProgress') throw new AppError(409, 'request_closed', `This request is already ${r.Status.toLowerCase()}`);

    await tenantQuery(
      tenantId,
      `UPDATE Requests SET Status = 'Cancelled', CurrentStepOrder = NULL, ClosedAt = SYSUTCDATETIME(), CancelledBy = @By, CancelReason = @Reason
        WHERE TenantId = @TenantId AND RequestId = @RequestId AND Status = 'InProgress'`,
      { By: adminUserId, Reason: reason, RequestId: requestId },
      tx,
    );
    await tenantQuery(
      tenantId,
      `UPDATE RequestSteps SET Status = 'Cancelled'
        WHERE TenantId = @TenantId AND RequestId = @RequestId AND Status IN ('Waiting','Active','Returned')`,
      { RequestId: requestId },
      tx,
    );
    await tenantQuery(
      tenantId,
      `UPDATE tok SET RevokedAt = SYSUTCDATETIME()
         FROM ApprovalTokens tok JOIN RequestSteps rs ON rs.TenantId = tok.TenantId AND rs.RequestStepId = tok.RequestStepId
        WHERE tok.TenantId = @TenantId AND rs.RequestId = @RequestId AND tok.RevokedAt IS NULL AND tok.ConsumedAt IS NULL`,
      { RequestId: requestId },
      tx,
    );
    await audit(
      tenantId,
      actor,
      { action: 'request.cancelled', entityType: 'Request', entityId: requestId, requestId, fromState: 'InProgress', toState: 'Cancelled', detail: { reason } },
      tx,
    );
    await queueNotification(
      tenantId,
      {
        type: 'Cancelled',
        to: { userId: r.SubmitterUserId, email: r.Email },
        subject: `Your ${r.FormName} request ${r.RequestNumber} was cancelled`,
        bodyHtml: emailBody([`Hello ${r.DisplayName},`, 'An administrator cancelled your request.', { label: 'Reason', value: reason }]),
        requestId,
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------------------
// reassign / remind (admin actions and the reminder sweeper). Neither changes the request's state.
// ---------------------------------------------------------------------------------------
interface ActiveStepRow {
  RequestId: number; RequestNumber: string; RequestStatus: string; FormName: string; TenantSlug: string; SubmitterName: string;
  StepOrder: number; StepName: string; StepStatus: string; AssignedUserId: number; DelegateUserId: number | null; TotalSteps: number;
}

async function lockStep(tenantId: number, requestStepId: number, tx: Tx): Promise<ActiveStepRow> {
  const [owner] = await tenantQuery<{ RequestId: number }>(tenantId, 'SELECT RequestId FROM RequestSteps WHERE TenantId = @TenantId AND RequestStepId = @S', { S: requestStepId }, tx);
  if (!owner) throw new AppError(404, 'not_found', 'Approval step not found');
  await tenantQuery(tenantId, 'SELECT RequestId FROM Requests WITH (UPDLOCK, ROWLOCK) WHERE TenantId = @TenantId AND RequestId = @R', { R: owner.RequestId }, tx);
  const [row] = await tenantQuery<ActiveStepRow>(
    tenantId,
    `SELECT r.RequestId, r.RequestNumber, r.Status AS RequestStatus, r.TotalSteps, f.Name AS FormName, t.Slug AS TenantSlug, su.DisplayName AS SubmitterName,
            rs.StepOrder, rs.StepName, rs.Status AS StepStatus, rs.AssignedUserId, rs.DelegateUserId
       FROM RequestSteps rs
       JOIN Requests r ON r.TenantId = rs.TenantId AND r.RequestId = rs.RequestId
       JOIN Forms f ON f.TenantId = r.TenantId AND f.FormId = r.FormId
       JOIN Tenants t ON t.TenantId = r.TenantId
       JOIN Users su ON su.TenantId = r.TenantId AND su.UserId = r.SubmitterUserId
      WHERE rs.TenantId = @TenantId AND rs.RequestStepId = @S`,
    { S: requestStepId },
    tx,
  );
  if (row.RequestStatus !== 'InProgress') throw new AppError(409, 'request_closed', `This request is ${row.RequestStatus.toLowerCase()} and can no longer be changed`);
  return row;
}

async function approverById(tenantId: number, userId: number, tx: Tx) {
  const [u] = await tenantQuery<{ UserId: number; Email: string; DisplayName: string }>(
    tenantId,
    `SELECT u.UserId, u.Email, u.DisplayName FROM Users u
      WHERE u.TenantId = @TenantId AND u.UserId = @UserId AND u.IsActive = 1
        AND EXISTS (SELECT 1 FROM UserRoles r WHERE r.TenantId = u.TenantId AND r.UserId = u.UserId AND r.Role IN ('Approver','Admin'))`,
    { UserId: userId },
    tx,
  );
  if (!u) throw new AppError(400, 'not_an_approver', 'The selected user is not an active approver in this organisation');
  return u;
}

async function sendStepLink(
  tenantId: number, row: ActiveStepRow, requestStepId: number, to: { UserId: number; Email: string; DisplayName: string },
  type: 'ApprovalRequested' | 'Reminder' | 'Reassigned', intro: string, tx: Tx,
): Promise<void> {
  const link = await issueApprovalLink(tenantId, row.TenantSlug, requestStepId, to.UserId, tx);
  await queueNotification(
    tenantId,
    {
      type,
      to: { userId: to.UserId, email: to.Email },
      subject: `${type === 'Reminder' ? 'Reminder: approval' : 'Approval'} needed: ${row.FormName} ${row.RequestNumber}`,
      bodyHtml: emailBody([
        `Hello ${to.DisplayName},`,
        intro,
        { label: 'Form', value: row.FormName },
        { label: 'Request', value: row.RequestNumber },
        { label: 'Submitted by', value: row.SubmitterName },
        { label: 'Step', value: `${row.StepOrder} of ${row.TotalSteps} - ${row.StepName}` },
        ...(await decisionLines(tenantId, row.RequestId, link, tx)),
      ]),
      requestId: row.RequestId,
      requestStepId,
    },
    tx,
  );
}

/**
 * Admin reassignment. asDelegate=false replaces the approver (their link stops working);
 * asDelegate=true keeps the original approver and lets the delegate act as well.
 */
export async function reassignStep(tenantId: number, actor: Actor, requestStepId: number, newUserId: number, asDelegate: boolean): Promise<void> {
  await withTx(async (tx) => {
    const row = await lockStep(tenantId, requestStepId, tx);
    // a Returned step can be handed over too: whoever has it when the submitter resubmits gets it back
    if (!['Active', 'Waiting', 'Returned'].includes(row.StepStatus)) throw new AppError(409, 'step_already_decided', 'This step has already been completed');
    if (newUserId === row.AssignedUserId) throw new AppError(400, 'same_user', 'That user is already the approver for this step');
    const user = await approverById(tenantId, newUserId, tx);

    await tenantQuery(
      tenantId,
      asDelegate
        ? `UPDATE RequestSteps SET DelegateUserId = @New WHERE TenantId = @TenantId AND RequestStepId = @S AND Status IN ('Active','Waiting','Returned')`
        : `UPDATE RequestSteps SET AssignedUserId = @New, DelegateUserId = NULL WHERE TenantId = @TenantId AND RequestStepId = @S AND Status IN ('Active','Waiting','Returned')`,
      { New: newUserId, S: requestStepId },
      tx,
    );
    // whoever lost access (old approver, or a previous delegate) can no longer use their link
    await tenantQuery(
      tenantId,
      `UPDATE ApprovalTokens SET RevokedAt = SYSUTCDATETIME()
        WHERE TenantId = @TenantId AND RequestStepId = @S AND RevokedAt IS NULL AND ConsumedAt IS NULL AND UserId <> @Keep`,
      { S: requestStepId, Keep: asDelegate ? row.AssignedUserId : newUserId },
      tx,
    );
    await audit(
      tenantId,
      actor,
      { action: asDelegate ? 'step.delegated' : 'step.reassigned', entityType: 'RequestStep', entityId: requestStepId, requestId: row.RequestId, detail: { stepOrder: row.StepOrder, fromUserId: row.AssignedUserId, toUserId: newUserId, previousDelegate: row.DelegateUserId ?? undefined } },
      tx,
    );
    if (row.StepStatus === 'Active') {
      await sendStepLink(tenantId, row, requestStepId, user, 'Reassigned', asDelegate ? 'An administrator has asked you to act as a delegate on this approval.' : 'An administrator has assigned this approval to you.', tx);
    }
  });
}

/** Sends the current approver (and delegate) a reminder with a fresh link. Used by admins and by the reminder sweeper. */
export async function remindStep(tenantId: number, actor: Actor, requestStepId: number, reason: 'manual' | 'scheduled'): Promise<void> {
  await withTx(async (tx) => {
    const row = await lockStep(tenantId, requestStepId, tx);
    if (row.StepStatus !== 'Active') throw new AppError(409, 'step_not_active', 'Only the step currently awaiting a decision can be reminded');
    const recipients = await tenantQuery<{ UserId: number; Email: string; DisplayName: string }>(
      tenantId,
      'SELECT UserId, Email, DisplayName FROM Users WHERE TenantId = @TenantId AND IsActive = 1 AND UserId IN (@A, @D)',
      { A: row.AssignedUserId, D: row.DelegateUserId ?? row.AssignedUserId },
      tx,
    );
    for (const to of recipients) await sendStepLink(tenantId, row, requestStepId, to, 'Reminder', 'This request is still waiting for your decision.', tx);
    await tenantQuery(
      tenantId,
      `UPDATE RequestSteps SET LastReminderAt = SYSUTCDATETIME(), ReminderCount = ReminderCount + 1
        WHERE TenantId = @TenantId AND RequestStepId = @S AND Status = 'Active'`,
      { S: requestStepId },
      tx,
    );
    await audit(tenantId, actor, { action: 'step.reminder_sent', entityType: 'RequestStep', entityId: requestStepId, requestId: row.RequestId, detail: { stepOrder: row.StepOrder, reason, recipients: recipients.map((r) => r.UserId) } }, tx);
  });
}
