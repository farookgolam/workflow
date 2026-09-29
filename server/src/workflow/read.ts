import { tenantQuery } from '../db/query';

export interface FieldValue {
  key: string;
  label: string;
  type: string;
  value: string | null;
}

export interface StepView {
  requestStepId: number;
  stepId: number;
  stepOrder: number;
  name: string;
  status: 'Waiting' | 'Active' | 'Returned' | 'Approved' | 'Rejected' | 'Cancelled' | 'NotReached';
  assignedUserId: number;
  assignedTo: string;
  delegateUserId: number | null;
  activatedAt: Date | null;
  dueAt: Date | null;
  actedAt: Date | null;
  actedBy: string | null;
  actedIp: string | null;
  comments: string | null;
  /** The approver's drawn signature (JSON pen strokes), given on approve. Not in submitterView (it is in the PDF). */
  signature: string | null;
  responses: FieldValue[];
  /** Never shown to the submitter - see submitterView. */
  attachments: AttachmentInfo[];
}

export interface AttachmentInfo {
  attachmentId: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedByUserId: number;
  createdAt: Date;
}

/** One field the submitter changed when they resubmitted after a send-back. Values are stored text (as in RequestData). */
export interface FieldChange {
  key: string;
  label: string;
  type: string;
  from: string | null;
  to: string | null;
}

/** One send-back round: an approver returned the request for changes, and (once resubmitted) what came back. */
export interface ReturnView {
  returnId: number;
  requestStepId: number;
  stepOrder: number;
  stepName: string;
  returnedBy: string;
  returnedAt: Date;
  reason: string;
  resubmittedAt: Date | null;
  resubmitNote: string | null;
  changes: FieldChange[];
}

export interface RequestDetail {
  requestId: number;
  requestNumber: string;
  formId: number;
  formName: string;
  submittersSeeComments: boolean;
  status: 'InProgress' | 'Approved' | 'Rejected' | 'Cancelled';
  currentStepOrder: number | null;
  totalSteps: number;
  submitterUserId: number;
  submitterName: string;
  submittedAt: Date;
  closedAt: Date | null;
  rejectionReason: string | null;
  rejectedStepOrder: number | null;
  cancelReason: string | null;
  archiveStatus: string;
  pdfStored: boolean;
  data: FieldValue[];
  steps: StepView[];
  /** Send-back rounds, oldest first. The last one is still open while a step is Returned. */
  returns: ReturnView[];
}

/** Full, unfiltered picture of one request. Callers decide what their audience may see. */
export async function loadRequestDetail(tenantId: number, requestId: number): Promise<RequestDetail | null> {
  const [r] = await tenantQuery<Record<string, never>>(
    tenantId,
    `SELECT r.RequestId, r.RequestNumber, r.FormId, f.Name AS FormName, f.SubmittersSeeComments, r.Status, r.CurrentStepOrder,
            r.TotalSteps, r.SubmitterUserId, u.DisplayName AS SubmitterName, r.SubmittedAt, r.ClosedAt, r.RejectionReason,
            rj.StepOrder AS RejectedStepOrder, r.CancelReason, r.ArchiveStatus,
            CASE WHEN EXISTS (SELECT 1 FROM RequestDocuments d WHERE d.TenantId = r.TenantId AND d.RequestId = r.RequestId) OR r.PdfLocalPath IS NOT NULL
                 THEN 1 ELSE 0 END AS PdfStored
       FROM Requests r
       JOIN Forms f ON f.TenantId = r.TenantId AND f.FormId = r.FormId
       JOIN Users u ON u.TenantId = r.TenantId AND u.UserId = r.SubmitterUserId
       LEFT JOIN RequestSteps rj ON rj.TenantId = r.TenantId AND rj.RequestStepId = r.RejectedRequestStepId
      WHERE r.TenantId = @TenantId AND r.RequestId = @RequestId`,
    { RequestId: requestId },
  );
  if (!r) return null;
  const row = r as Record<string, any>;

  const data = await tenantQuery<{ FieldKey: string; FieldLabel: string; FieldType: string; Value: string | null }>(
    tenantId,
    'SELECT FieldKey, FieldLabel, FieldType, Value FROM RequestData WHERE TenantId = @TenantId AND RequestId = @RequestId ORDER BY SortOrder',
    { RequestId: requestId },
  );
  const steps = await tenantQuery<Record<string, any>>(
    tenantId,
    `SELECT rs.RequestStepId, rs.StepId, rs.StepOrder, rs.StepName, rs.Status, rs.AssignedUserId,
            CASE WHEN rs.Status = 'Waiting' AND st.ApproverChosen = 1 THEN CASE WHEN rs.StepOrder = 1 THEN N'(chosen by the submitter)' ELSE N'(chosen by the previous approver)' END ELSE au.DisplayName END AS AssignedTo,
            rs.DelegateUserId, rs.ActivatedAt, rs.DueAt, rs.ActedAt, bu.DisplayName AS ActedBy, rs.ActedIp, rs.Comments, rs.Signature
       FROM RequestSteps rs
       JOIN Users au ON au.TenantId = rs.TenantId AND au.UserId = rs.AssignedUserId
       JOIN ApprovalSteps st ON st.TenantId = rs.TenantId AND st.StepId = rs.StepId
       LEFT JOIN Users bu ON bu.TenantId = rs.TenantId AND bu.UserId = rs.ActedByUserId
      WHERE rs.TenantId = @TenantId AND rs.RequestId = @RequestId ORDER BY rs.StepOrder`,
    { RequestId: requestId },
  );
  const responses = await tenantQuery<{ RequestStepId: number; FieldKey: string; FieldLabel: string; FieldType: string; Value: string | null }>(
    tenantId,
    `SELECT sr.RequestStepId, sr.FieldKey, sr.FieldLabel, sr.FieldType, sr.Value
       FROM StepResponses sr JOIN RequestSteps rs ON rs.TenantId = sr.TenantId AND rs.RequestStepId = sr.RequestStepId
      WHERE sr.TenantId = @TenantId AND rs.RequestId = @RequestId ORDER BY sr.RequestStepId, sr.SortOrder`,
    { RequestId: requestId },
  );
  const attachments = await tenantQuery<Record<string, any>>(
    tenantId,
    `SELECT a.AttachmentId, a.RequestStepId, a.FileName, a.ContentType, a.SizeBytes, a.UploadedByUserId, u.DisplayName AS UploadedBy, a.CreatedAt
       FROM StepAttachments a JOIN Users u ON u.TenantId = a.TenantId AND u.UserId = a.UploadedByUserId
      WHERE a.TenantId = @TenantId AND a.RequestId = @RequestId ORDER BY a.AttachmentId`,
    { RequestId: requestId },
  );
  const returns = await tenantQuery<Record<string, any>>(
    tenantId,
    `SELECT rr.ReturnId, rr.RequestStepId, rr.StepOrder, rs.StepName, u.DisplayName AS ReturnedBy, rr.ReturnedAt, rr.Reason,
            rr.ResubmittedAt, rr.ResubmitNote, rr.ChangesJson
       FROM RequestReturns rr
       JOIN RequestSteps rs ON rs.TenantId = rr.TenantId AND rs.RequestStepId = rr.RequestStepId
       JOIN Users u ON u.TenantId = rr.TenantId AND u.UserId = rr.ReturnedByUserId
      WHERE rr.TenantId = @TenantId AND rr.RequestId = @RequestId ORDER BY rr.ReturnId`,
    { RequestId: requestId },
  );
  const fv = (x: { FieldKey: string; FieldLabel: string; FieldType: string; Value: string | null }): FieldValue => ({
    key: x.FieldKey,
    label: x.FieldLabel,
    type: x.FieldType,
    value: x.Value,
  });

  return {
    requestId: row.RequestId,
    requestNumber: row.RequestNumber,
    formId: row.FormId,
    formName: row.FormName,
    submittersSeeComments: row.SubmittersSeeComments,
    status: row.Status,
    currentStepOrder: row.CurrentStepOrder,
    totalSteps: row.TotalSteps,
    submitterUserId: row.SubmitterUserId,
    submitterName: row.SubmitterName,
    submittedAt: row.SubmittedAt,
    closedAt: row.ClosedAt,
    rejectionReason: row.RejectionReason,
    rejectedStepOrder: row.RejectedStepOrder,
    cancelReason: row.CancelReason,
    archiveStatus: row.ArchiveStatus,
    pdfStored: row.PdfStored === 1,
    data: data.map(fv),
    steps: steps.map((s) => ({
      requestStepId: s.RequestStepId,
      stepId: s.StepId,
      stepOrder: s.StepOrder,
      name: s.StepName,
      status: s.Status,
      assignedUserId: s.AssignedUserId,
      assignedTo: s.AssignedTo,
      delegateUserId: s.DelegateUserId,
      activatedAt: s.ActivatedAt,
      dueAt: s.DueAt,
      actedAt: s.ActedAt,
      actedBy: s.ActedBy,
      actedIp: s.ActedIp,
      comments: s.Comments,
      signature: s.Signature,
      responses: responses.filter((x) => x.RequestStepId === s.RequestStepId).map(fv),
      attachments: attachments
        .filter((a) => a.RequestStepId === s.RequestStepId)
        .map((a) => ({
          attachmentId: Number(a.AttachmentId),
          fileName: a.FileName,
          contentType: a.ContentType,
          sizeBytes: a.SizeBytes,
          uploadedBy: a.UploadedBy,
          uploadedByUserId: a.UploadedByUserId,
          createdAt: a.CreatedAt,
        })),
    })),
    returns: returns.map((x) => ({
      returnId: x.ReturnId,
      requestStepId: x.RequestStepId,
      stepOrder: x.StepOrder,
      stepName: x.StepName,
      returnedBy: x.ReturnedBy,
      returnedAt: x.ReturnedAt,
      reason: x.Reason,
      resubmittedAt: x.ResubmittedAt,
      resubmitNote: x.ResubmitNote,
      changes: x.ChangesJson ? (JSON.parse(x.ChangesJson) as FieldChange[]) : [],
    })),
  };
}

/** What a submitter may see of their own request: decisions always, approver-entered content only if the form allows. */
export function submitterView(d: RequestDetail) {
  const current = d.steps.find((s) => s.status === 'Active');
  const rejectedStep = d.steps.find((s) => s.status === 'Rejected');
  // the submitter always sees why it came back to them - they cannot fix it otherwise
  const open = d.steps.some((s) => s.status === 'Returned') ? d.returns[d.returns.length - 1] : undefined;
  return {
    requestId: d.requestId,
    requestNumber: d.requestNumber,
    formId: d.formId,
    formName: d.formName,
    status: d.status,
    submittedAt: d.submittedAt,
    closedAt: d.closedAt,
    progress: {
      currentStep: d.currentStepOrder,
      totalSteps: d.totalSteps,
      waitingOn: current?.assignedTo ?? null,
      waitingSince: current?.activatedAt ?? null,
      label: current
        ? `Step ${current.stepOrder} of ${d.totalSteps}, waiting on ${current.assignedTo}`
        : open ? `Sent back to you for changes by ${open.returnedBy}` : d.status,
    },
    sentBack: open ? { stepOrder: open.stepOrder, stepName: open.stepName, returnedBy: open.returnedBy, returnedAt: open.returnedAt, reason: open.reason } : null,
    returns: d.returns.map(({ returnId: _, requestStepId: __, ...r }) => r),
    rejection:
      d.status === 'Rejected'
        ? { reason: d.rejectionReason, stepOrder: d.rejectedStepOrder, stepName: rejectedStep?.name ?? null, rejectedBy: rejectedStep?.actedBy ?? null, rejectedAt: rejectedStep?.actedAt ?? null }
        : null,
    cancelReason: d.cancelReason,
    pdfAvailable: d.pdfStored,
    data: d.data,
    steps: d.steps.map((s) => ({
      stepOrder: s.stepOrder,
      name: s.name,
      status: s.status,
      approver: s.actedBy ?? s.assignedTo,
      activatedAt: s.activatedAt,
      actedAt: s.actedAt,
      ...(d.submittersSeeComments ? { comments: s.comments, responses: s.responses } : {}),
    })),
  };
}
