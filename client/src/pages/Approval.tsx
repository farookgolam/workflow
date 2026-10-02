import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, download } from '../api';
import { NextApproverPicker, choicePayload, needsChoice, type StepHandOff } from '../approvers';
import { AttachmentList, AttachmentUploader, type Attachment } from '../attachments';
import { StatusBadge, ValueList, fmtDateTime, type FieldValue } from '../fields';
import { ChangeList, SendBackHistory, type SendBack } from '../sendback';
import { SignOff, type SignOffStep } from '../signoff';
import { SignatureImage, SignaturePad } from '../sigpad';

/** What the approver pressed in the email: Approve, Send back or Reject (opens the page ready for that). */
export type Intent = 'approve' | 'return' | 'reject';
const asIntent = (v: string | null): Intent | undefined => (v === 'approve' || v === 'return' || v === 'reject' ? v : undefined);

/** Landing point of the emailed link: /approve?token=…[&do=approve|return|reject] (already behind sign-in). */
export function ApproveLinkPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const intent = asIntent(params.get('do'));
  const [target, setTarget] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    api<{ requestStepId: number }>(`/approvals/resolve?token=${encodeURIComponent(token)}`)
      .then((r) => live && setTarget(r.requestStepId))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : 'Could not open this link.'));
    return () => void (live = false);
  }, [token]);

  // hand the token (and the button pressed) to the approval page in navigation state, then drop them from the URL
  if (target) return <Navigate to={`/approvals/${target}`} state={{ token, intent }} replace />;
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
  signature: string | null;
}
interface ApprovalView {
  request: { requestId: number; requestNumber: string; formName: string; status: string; submitterName: string; submittedAt: string; totalSteps: number; rejectionReason: string | null; pdfAvailable: boolean };
  submission: FieldValue[];
  previousSteps: PreviousStep[];
  /** send-backs up to this step, oldest first; the last is still open while this step is Returned */
  returns: SendBack[];
  step: {
    requestStepId: number;
    stepOrder: number;
    name: string;
    status: string;
    canAct: boolean;
    dueAt: string | null;
    attachments: Attachment[];
    nextStep: StepHandOff | null; // who the request goes to if this step is approved (null on the last step)
    decided: { decision: string; actedBy: string | null; actedAt: string | null; comments: string | null; responses: FieldValue[]; signature: string | null } | null;
  };
}

export function ApprovalPage() {
  const { requestStepId } = useParams();
  const nav = useLocation().state as { token?: string; intent?: Intent } | null;
  const token = nav?.token;
  const intent = nav?.intent;
  const [view, setView] = useState<ApprovalView | null>(null);
  const [loadError, setLoadError] = useState('');

  const [comments, setComments] = useState('');
  const [signature, setSignature] = useState(''); // pen strokes as JSON, '' = not signed; required to approve
  const [nextApprover, setNextApprover] = useState<string | null>(null); // who this approver picked for the next step, on a chosen step
  const [mode, setMode] = useState<Intent>(intent ?? 'approve'); // which decision the form is set up for
  const [reason, setReason] = useState('');
  const [returnReason, setReturnReason] = useState('');
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
  const { request, submission, previousSteps, step, returns } = view;
  const openReturn = step.status === 'Returned' ? returns[returns.length - 1] : undefined;
  // came back to this step after this approver sent it back: show what changed first
  const lastBack = [...returns].reverse().find((x) => x.stepOrder === step.stepOrder && x.resubmittedAt);

  const send = async (decision: Intent) => {
    setErrors({});
    setFormError('');
    if (decision === 'reject' && !reason.trim()) return setErrors({ rejectionReason: 'A rejection reason is required' });
    if (decision === 'return' && !returnReason.trim()) return setErrors({ returnReason: 'Say what needs to change' });
    if (decision === 'approve' && !signature) return setErrors({ signature: 'Sign to approve' });
    if (decision === 'approve' && needsChoice(step.nextStep, nextApprover)) return setErrors({ nextApproverUserId: `Choose who approves "${step.nextStep!.name}".` });
    setBusy(true);
    try {
      const result = await api<{ requestStatus: string; nextStepOrder: number | null }>(`/approvals/${step.requestStepId}/decision`, {
        method: 'POST',
        body: { decision, comments: decision === 'return' ? undefined : comments.trim() || undefined, rejectionReason: decision === 'reject' ? reason.trim() : undefined, returnReason: decision === 'return' ? returnReason.trim() : undefined, token, ...(decision === 'approve' ? { signature: JSON.parse(signature), ...choicePayload(step.nextStep, nextApprover, 'next') } : {}) },
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

  const yourSection = (
    <section className={`card ${step.canAct ? 'card-active' : ''}`}>
      <h2>Your section{!step.canAct && <span className="tag">Read-only</span>}</h2>

      {step.decided && (
        <>
          <div className="prev-head"><span className="muted">{step.decided.actedBy}, {fmtDateTime(step.decided.actedAt)}</span><StatusBadge status={step.decided.decision} /></div>
          <ValueList items={step.decided.responses} />
          {step.decided.comments && <blockquote>{step.decided.comments}</blockquote>}
          {step.decided.signature && <SignatureImage value={step.decided.signature} label={`Signature of ${step.decided.actedBy}`} />}
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
      {openReturn && (
        <div className="notice back">
          <p style={{ marginTop: 0 }}><strong>Sent back by {openReturn.returnedBy}</strong> to {request.submitterName} for changes on {fmtDateTime(openReturn.returnedAt)}.</p>
          <blockquote>{openReturn.reason}</blockquote>
          <p style={{ marginBottom: 0 }}>It comes back to this step, and you are emailed, when they resubmit.</p>
          <AttachmentList items={step.attachments} pathOf={(a) => `/approvals/requests/${request.requestId}/attachments/${a.attachmentId}`} />
        </div>
      )}
      {!step.decided && !step.canAct && !openReturn && (
        <p className="muted">{step.status === 'Waiting' ? 'This step is not active yet - earlier approvers have not finished.' : `This step is ${step.status.toLowerCase()}; no action is needed.`}</p>
      )}

      {step.canAct && (
        <form onSubmit={(e) => e.preventDefault()} noValidate>
          {formError && <p className="notice bad" role="alert">{formError}</p>}
          <div className="seg" role="group" aria-label="Your decision" style={{ marginBottom: '1rem' }}>
            {([['approve', 'Approve'], ['return', 'Send back for changes'], ['reject', 'Reject']] as const).map(([m, label]) => (
              <button key={m} type="button" className={mode === m ? 'on' : ''} aria-pressed={mode === m} disabled={busy} onClick={() => { setMode(m); setErrors({}); }}>{label}</button>
            ))}
          </div>

          {mode === 'approve' && (
            <>
              <div className="field">
                <label htmlFor="comments">Comments</label>
                <textarea id="comments" rows={3} maxLength={4000} value={comments} disabled={busy} onChange={(e) => setComments(e.target.value)} />
              </div>
              <AttachmentUploader requestStepId={step.requestStepId} requestId={request.requestId} items={step.attachments} max={10} disabled={busy} onChange={load} />
              <div className="field">
                <label htmlFor="signature">Your signature<em className="req"> *</em></label>
                <SignaturePad id="signature" label="Your signature" value={signature} disabled={busy} invalid={!!errors.signature} describedBy={errors.signature ? 'signature-error' : undefined} onChange={(v) => { setSignature(v); setErrors(({ signature: _, ...rest }) => rest); }} />
                {errors.signature && <p className="field-error" id="signature-error">{errors.signature}</p>}
                <p className="hint">Needed to approve. Sending back or rejecting does not need a signature.</p>
              </div>
              {step.nextStep && <NextApproverPicker id="next-approver" step={step.nextStep} totalSteps={request.totalSteps} when="as soon as you approve" value={nextApprover} error={errors.nextApprover ?? errors.nextApproverUserId ?? errors.nextApproverKey} disabled={busy} onChange={setNextApprover} />}
              <div className="actions">
                <button type="button" className="primary" disabled={busy} onClick={() => void send('approve')}>{step.nextStep ? 'Approve and send on' : 'Approve'}</button>
              </div>
            </>
          )}

          {mode === 'return' && (
            <div className="return-box">
              <div className="field">
                <label htmlFor="return-reason">What needs to change?<em className="req"> *</em></label>
                <textarea id="return-reason" rows={3} maxLength={2000} value={returnReason} disabled={busy} aria-invalid={!!errors.returnReason} onChange={(e) => setReturnReason(e.target.value)} autoFocus />
                {errors.returnReason && <p className="field-error">{errors.returnReason}</p>}
                <p className="hint">{request.submitterName} is emailed this and can edit the request and resubmit it. {step.stepOrder > 1 ? 'Earlier approvals stay as they are, and it' : 'It'} comes straight back to you.</p>
              </div>
              <div className="actions">
                <button type="button" className="primary" disabled={busy} onClick={() => void send('return')}>Send back to {request.submitterName}</button>
              </div>
            </div>
          )}

          {mode === 'reject' && (
            <div className="reject-box">
              <div className="field">
                <label htmlFor="reason">Reason for rejection<em className="req"> *</em></label>
                <textarea id="reason" rows={3} maxLength={2000} value={reason} disabled={busy} aria-invalid={!!errors.rejectionReason} onChange={(e) => setReason(e.target.value)} autoFocus />
                {errors.rejectionReason && <p className="field-error">{errors.rejectionReason}</p>}
                <p className="hint">Rejection is final: the workflow stops, the submitter is sent this reason, and the request cannot be reopened. If it only needs fixing, send it back instead.</p>
              </div>
              <div className="actions">
                <button type="button" className="danger" disabled={busy} onClick={() => void send('reject')}>Confirm rejection</button>
              </div>
            </div>
          )}
        </form>
      )}
    </section>
  );
  // arrived from a button in the email: on a narrow screen the decision comes first, the details under it
  const quick = !!intent && step.canAct && !outcome;

  // The sign-off strip, as far as this approver may see: earlier steps, their own, and what is still to come.
  const stopped = request.status === 'Rejected' || request.status === 'Cancelled';
  const strip: SignOffStep[] = [
    ...previousSteps.map((p) => ({ stepOrder: p.stepOrder, name: p.name, status: p.decision, approver: p.actedBy, actedAt: p.actedAt })),
    {
      stepOrder: step.stepOrder, name: step.name, status: step.decided?.decision ?? step.status,
      approver: step.decided?.actedBy ?? openReturn?.returnedBy ?? null, actedAt: step.decided?.actedAt,
    },
    ...Array.from({ length: request.totalSteps - step.stepOrder }, (_, i) => {
      const next = i === 0 ? step.nextStep : null;
      return {
        stepOrder: step.stepOrder + i + 1, name: next?.name ?? null, status: stopped ? (request.status === 'Rejected' ? 'NotReached' : 'Cancelled') : 'Waiting',
        approver: stopped ? null : next ? (next.mode === 'chosen' ? (step.canAct ? 'You choose who' : 'Chosen by the approver before') : next.approver?.displayName ?? null) : 'Not reached yet',
      };
    }),
  ];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow"><Link to={'/'}>Waiting for my approval</Link> / {request.requestNumber}</p>
          <div className="title-row"><h1>{request.formName}</h1><span className="reqno">{request.requestNumber}</span></div>
          <p className="muted">Submitted by {request.submitterName} on {fmtDateTime(request.submittedAt)}. Step {step.stepOrder} of {request.totalSteps}: {step.name}.</p>
        </div>
        <StatusBadge status={step.status === 'Returned' ? 'Returned' : request.status} />
      </div>
      <SignOff steps={strip} big mine={step.canAct ? step.stepOrder : undefined} />

      {outcome && (
        <p className={`notice ${outcome.requestStatus === 'Rejected' ? 'bad' : 'ok'}`} role="status">
          {outcome.requestStatus === 'Rejected' && 'You rejected this request. The submitter and the administrator have been notified.'}
          {outcome.requestStatus === 'Returned' && `Sent back to ${request.submitterName}. It comes back to you, with an email, when they resubmit.`}
          {outcome.requestStatus === 'Approved' && 'Approved. That was the final step - the submitter has been notified.'}
          {outcome.requestStatus === 'InProgress' && `Approved. The request has moved on to step ${outcome.nextStepOrder}.`}
        </p>
      )}

      {step.canAct && lastBack && (
        <section className="notice back">
          <p style={{ marginTop: 0 }}><strong>Resubmitted by {request.submitterName}</strong> on {fmtDateTime(lastBack.resubmittedAt)}, after {lastBack.returnedBy} sent it back: “{lastBack.reason}”</p>
          <ChangeList changes={lastBack.changes} />
          {lastBack.resubmitNote && <blockquote>{lastBack.resubmitNote}</blockquote>}
        </section>
      )}

      {/* the request reads like a document on the left; the decision stays in view beside it */}
      <div className={`approve${quick ? ' quick' : ''}`}>
        <div className="approve-doc">
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
                  <p className="muted small">{p.actedBy}, {fmtDateTime(p.actedAt)}</p>
                  <ValueList items={p.responses} />
                  {p.comments && <blockquote>{p.comments}</blockquote>}
                  {p.signature && <SignatureImage value={p.signature} label={`Signature of ${p.actedBy}`} />}
                  <AttachmentList items={p.attachments} pathOf={(a) => `/approvals/requests/${request.requestId}/attachments/${a.attachmentId}`} />
                </div>
              ))}
            </section>
          )}

          {/* the round shown at the top is not repeated here */}
          <SendBackHistory items={returns.filter((x) => !(step.canAct && x === lastBack))} />
        </div>
        <aside className="approve-side">
          {quick && <p className="muted small">Check the request before you confirm.</p>}
          {yourSection}
        </aside>
      </div>

      <p><Link to={'/'}>← My approvals</Link></p>
    </div>
  );
}
