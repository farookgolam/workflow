import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, download } from '../api';
import { NextApproverPicker, choicePayload, needsChoice, type StepHandOff } from '../approvers';
import { AttachmentList, AttachmentUploader, type Attachment } from '../attachments';
import { StatusBadge, ValueList, fmtDateTime, type FieldValue } from '../fields';

/** Landing point of the emailed link: /approve?token=… (already behind sign-in). */
export function ApproveLinkPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [target, setTarget] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api<{ requestStepId: number }>(`/approvals/resolve?token=${encodeURIComponent(token)}`)
      .then((r) => live && setTarget(r.requestStepId))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : 'Could not open this link.'));
    return () => void (live = false);
  }, [token]);

  // hand the token to the approval page in navigation state so it is sent with the decision, then drop it from the URL
  if (target) return <Navigate to={`/approvals/${target}`} state={{ token }} replace />;
  if (error) {
    return (
      <div className="card">
        <h1>This link can't be used</h1>
        <p className="notice bad">{error}</p>
        <Link to={'/'}>Go to my approvals</Link>
      </div>
    );
  }
  return <p className="muted center">Opening your approval…</p>;
}

interface PreviousStep {
  stepOrder: number;
  name: string;
  decision: string;
  actedBy: string | null;
  actedAt: string | null;
  comments: string | null;
  responses: FieldValue[];
  attachments: Attachment[];
}
interface ApprovalView {
  request: { requestId: number; requestNumber: string; formName: string; status: string; submitterName: string; submittedAt: string; totalSteps: number; rejectionReason: string | null; pdfAvailable: boolean };
  submission: FieldValue[];
  previousSteps: PreviousStep[];
  step: {
    requestStepId: number;
    stepOrder: number;
    name: string;
    status: string;
    canAct: boolean;
    dueAt: string | null;
    allowAttachments: boolean;
    attachments: Attachment[];
    nextStep: StepHandOff | null; // who the request goes to if this step is approved (null on the last step)
    decided: { decision: string; actedBy: string | null; actedAt: string | null; comments: string | null; responses: FieldValue[] } | null;
  };
}

export function ApprovalPage() {
  const { requestStepId } = useParams();
  const token = (useLocation().state as { token?: string } | null)?.token;
  const [view, setView] = useState<ApprovalView | null>(null);
  const [loadError, setLoadError] = useState('');

  const [comments, setComments] = useState('');
  const [nextApprover, setNextApprover] = useState<string | null>(null); // who this approver picked for the next step, on a chosen step
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [pdfError, setPdfError] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ requestStatus: string; nextStepOrder: number | null } | null>(null);

  const load = useCallback(() => {
    api<ApprovalView>(`/approvals/${requestStepId}`)
      .then(setView)
      .catch((e) => setLoadError(e instanceof ApiError && e.status === 404 ? 'This approval does not exist or is not assigned to you.' : 'Could not load this approval.'));
  }, [requestStepId]);
  useEffect(load, [load]);

  if (loadError) return <div className="card"><h1>Not available</h1><p className="notice bad">{loadError}</p><Link to={'/'}>Back to my approvals</Link></div>;
  if (!view) return <p className="muted center">Loading…</p>;
  const { request, submission, previousSteps, step } = view;

  const send = async (decision: 'approve' | 'reject') => {
    setErrors({});
    setFormError('');
    if (decision === 'reject' && !reason.trim()) return setErrors({ rejectionReason: 'A rejection reason is required' });
    if (decision === 'approve' && needsChoice(step.nextStep, nextApprover)) return setErrors({ nextApproverUserId: `Choose who approves "${step.nextStep!.name}".` });
    setBusy(true);
    try {
      const result = await api<{ requestStatus: string; nextStepOrder: number | null }>(`/approvals/${step.requestStepId}/decision`, {
        method: 'POST',
        body: { decision, comments: comments.trim() || undefined, rejectionReason: decision === 'reject' ? reason.trim() : undefined, token, ...(decision === 'approve' ? choicePayload(step.nextStep, nextApprover, 'next') : {}) },
      });
      setOutcome(result);
      load(); // re-read: the decision is now final and shown read-only
    } catch (e) {
      if (e instanceof ApiError && e.code === 'validation_failed') {
        setErrors(e.fieldErrors);
        setFormError('Please fix the highlighted fields.');
      } else if (e instanceof ApiError && e.status === 409) {
        setFormError(e.message);
        load();
      } else setFormError(e instanceof ApiError ? e.message : 'Something went wrong. Your decision was not saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">{request.formName} · {request.requestNumber}</p>
          <h1>Step {step.stepOrder} of {request.totalSteps}: {step.name}</h1>
          <p className="muted">Submitted by {request.submitterName} on {fmtDateTime(request.submittedAt)}</p>
        </div>
        <StatusBadge status={request.status} />
      </div>

      {outcome && (
        <p className={`notice ${outcome.requestStatus === 'Rejected' ? 'bad' : 'ok'}`} role="status">
          {outcome.requestStatus === 'Rejected' && 'You rejected this request. The submitter and the administrator have been notified.'}
          {outcome.requestStatus === 'Approved' && 'Approved. That was the final step - the submitter has been notified.'}
          {outcome.requestStatus === 'InProgress' && `Approved. The request has moved on to step ${outcome.nextStepOrder}.`}
        </p>
      )}

      <section className="card">
        <h2>Original submission <span className="tag">Read-only</span></h2>
        <ValueList items={submission} />
      </section>

      {previousSteps.length > 0 && (
        <section className="card">
          <h2>Previous approvals <span className="tag">Read-only</span></h2>
          {previousSteps.map((p) => (
            <div className="prev-step" key={p.stepOrder}>
              <div className="prev-head">
                <strong>Step {p.stepOrder}: {p.name}</strong>
                <StatusBadge status={p.decision} />
              </div>
              <p className="muted small">{p.actedBy} · {fmtDateTime(p.actedAt)}</p>
              <ValueList items={p.responses} />
              {p.comments && <blockquote>{p.comments}</blockquote>}
              <AttachmentList items={p.attachments} pathOf={(a) => `/approvals/requests/${request.requestId}/attachments/${a.attachmentId}`} />
            </div>
          ))}
        </section>
      )}

      <section className={`card ${step.canAct ? 'card-active' : ''}`}>
        <h2>Your section{!step.canAct && <span className="tag">Read-only</span>}</h2>

        {step.decided && (
          <>
            <div className="prev-head"><span className="muted">{step.decided.actedBy} · {fmtDateTime(step.decided.actedAt)}</span><StatusBadge status={step.decided.decision} /></div>
            <ValueList items={step.decided.responses} />
            {step.decided.comments && <blockquote>{step.decided.comments}</blockquote>}
            <AttachmentList items={step.attachments} pathOf={(a) => `/approvals/requests/${request.requestId}/attachments/${a.attachmentId}`} />
            {step.decided.decision === 'Rejected' && request.rejectionReason && <p><strong>Rejection reason:</strong> {request.rejectionReason}</p>}
          </>
        )}
        {request.pdfAvailable && (
          <p style={{ marginTop: '1rem' }}>
            <button onClick={() => { setPdfError(''); download(`/approvals/requests/${request.requestId}/pdf`, `${request.requestNumber}.pdf`).catch((e: Error) => setPdfError(e.message)); }}>Download PDF</button>
            {pdfError && <span className="field-error"> {pdfError}</span>}
          </p>
        )}
        {!step.decided && !step.canAct && (
          <p className="muted">{step.status === 'Waiting' ? 'This step is not active yet - earlier approvers have not finished.' : `This step is ${step.status.toLowerCase()}; no action is needed.`}</p>
        )}

        {step.canAct && (
          <form onSubmit={(e) => e.preventDefault()} noValidate>
            {formError && <p className="notice bad" role="alert">{formError}</p>}
            <div className="field">
              <label htmlFor="comments">Comments</label>
              <textarea id="comments" rows={3} maxLength={4000} value={comments} disabled={busy} onChange={(e) => setComments(e.target.value)} />
            </div>
            {step.allowAttachments && (
              <AttachmentUploader requestStepId={step.requestStepId} requestId={request.requestId} items={step.attachments} max={10} disabled={busy} onChange={load} />
            )}

            {rejecting ? (
              <div className="reject-box">
                <div className="field">
                  <label htmlFor="reason">Reason for rejection<em className="req"> *</em></label>
                  <textarea id="reason" rows={3} maxLength={2000} value={reason} disabled={busy} aria-invalid={!!errors.rejectionReason} onChange={(e) => setReason(e.target.value)} autoFocus />
                  {errors.rejectionReason && <p className="field-error">{errors.rejectionReason}</p>}
                  <p className="hint">Rejection is final: the workflow stops, the submitter is sent this reason, and the request cannot be reopened.</p>
                </div>
                <div className="actions">
                  <button type="button" className="danger" disabled={busy} onClick={() => void send('reject')}>Confirm rejection</button>
                  <button type="button" disabled={busy} onClick={() => setRejecting(false)}>Back</button>
                </div>
              </div>
            ) : (
              <>
              {step.nextStep && <NextApproverPicker id="next-approver" step={step.nextStep} totalSteps={request.totalSteps} when="as soon as you approve" value={nextApprover} error={errors.nextApprover ?? errors.nextApproverUserId ?? errors.nextApproverKey} disabled={busy} onChange={setNextApprover} />}
              <div className="actions">
                <button type="button" className="primary" disabled={busy} onClick={() => void send('approve')}>{step.nextStep ? 'Approve and send on' : 'Approve'}</button>
                <button type="button" className="danger-outline" disabled={busy} onClick={() => setRejecting(true)}>Reject…</button>
              </div>
              </>
            )}
          </form>
        )}
      </section>

      <p><Link to={'/'}>← My approvals</Link></p>
    </div>
  );
}
