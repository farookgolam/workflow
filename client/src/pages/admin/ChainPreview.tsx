// "Preview & test" for an approval chain, including unsaved changes: walk a pretend request through every stage -
// the submission and each step - seeing what that person sees, and try the hand-offs the server would allow.
// The approvers offered for a chosen step come from the server, worked out as for a real request. Nothing is saved,
// no request is created, no account is made from a lookup file and nobody is emailed.
import { useEffect, useState } from 'react';
import { ApiError, api } from '../../api';
import { useAuth } from '../../auth';
import { NextApproverPicker, needsChoice, optionId, type ApproverOption, type StepHandOff } from '../../approvers';
import { StatusBadge, ValueList, type FieldDef } from '../../fields';
import { SignatureImage, SignaturePad } from '../../sigpad';
import { type UserRow } from '../../hooks';
import { FormPreview, fieldProblems, type StoredValue } from './FormBuilder';

/** How a step's approver is found: `approverUserId` - always this person; `chosen` - picked by the person before, from a lookup file or (no lookupId) from every approver. */
export interface ChosenFrom { lookupId: number | null; emailColumn: string | null; nameColumn: string | null; columns: string[] }
export interface StepDef { name: string; approverUserId: number | null; chosen: ChosenFrom | null; reminderAfterDays: number | null; reminderRepeatDays: number | null; escalateAfterDays: number | null; escalateToUserId: number | null; allowAttachments?: boolean }

/** A step as the server takes it, for publishing or previewing. */
export const toChainStep = (s: StepDef) => ({
  name: s.name.trim(),
  approverUserId: s.chosen ? null : s.approverUserId,
  chosen: s.chosen && (s.chosen.lookupId ? s.chosen : { lookupId: null, emailColumn: null, nameColumn: null, columns: [] }),
  reminderAfterDays: s.reminderAfterDays, reminderRepeatDays: s.reminderRepeatDays, escalateAfterDays: s.escalateAfterDays, escalateToUserId: s.escalateToUserId,
  allowAttachments: !!s.allowAttachments,
});

/** What stops a step from being published: nobody to go to, or a lookup file without its email column. */
export const approverProblem = (s: StepDef) => (s.chosen ? (s.chosen.lookupId && !s.chosen.emailColumn ? 'Choose the column with each approver\'s email.' : '') : s.approverUserId ? '' : 'Choose the approver.');
export const stepProblem = (s: StepDef) => (!s.name.trim() ? 'Give the step a name.' : approverProblem(s));

const stepName = (s: StepDef, i: number) => s.name.trim() || `Step ${i + 1}`;
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** The reminder and escalation timetable of a step, in words. */
function timetable(s: StepDef, users: UserRow[]): string {
  const parts: string[] = [];
  if (s.reminderAfterDays) parts.push(`A reminder is emailed after ${days(s.reminderAfterDays)}${s.reminderRepeatDays ? `, then every ${days(s.reminderRepeatDays)}` : ''}.`);
  if (s.escalateAfterDays) parts.push(`After ${days(s.escalateAfterDays)} it is escalated to ${s.escalateToUserId ? users.find((u) => u.userId === s.escalateToUserId)?.displayName ?? 'the chosen person' : 'the administrators'}.`);
  return parts.join(' ') || 'No reminders or escalation: it waits until the approver acts.';
}

interface Decision { stepOrder: number; name: string; decision: 'Approved' | 'Rejected'; actedBy: string; comments: string; signature?: string; reason?: string }
type HandOffState = { step: StepHandOff } | { error: string } | null;

/** Loads who the step `next` (0-based) could go to, as the person handing on with `excludeUserIds` would see it. */
function useHandOff(steps: StepDef[], next: number | null, excludeUserIds: number[]): HandOffState {
  const [state, setState] = useState<HandOffState>(null);
  const s = next !== null ? steps[next] : undefined;
  const body = s ? JSON.stringify({ step: toChainStep({ ...s, name: stepName(s, next!) }), stepOrder: next! + 1, excludeUserIds }) : null;
  useEffect(() => {
    setState(null);
    if (!body || !s) return;
    if (approverProblem(s)) return setState({ error: approverProblem(s) });
    let live = true;
    api<StepHandOff>('/admin/forms/preview/handoff', { method: 'POST', body: JSON.parse(body) })
      .then((step) => live && setState({ step }))
      .catch((err) => live && setState({ error: err instanceof ApiError ? err.details[0]?.message ?? err.message : 'Could not work out who this step goes to.' }));
    return () => void (live = false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body]);
  return state;
}

/** The hand-off box, or why there is nobody to hand on to. */
function HandOff({ state, stepIndex, total, value, error, when, onChange }: { state: HandOffState; stepIndex: number; total: number; value: string | null; error?: string; when: string; onChange(v: string): void }) {
  if (!state) return <p className="muted small" style={{ marginTop: '1rem' }}>Working out who step {stepIndex + 1} goes to…</p>;
  if ('error' in state) return <p className="notice bad" role="alert" style={{ marginTop: '1rem' }}>Step {stepIndex + 1} cannot be handed on: {state.error}</p>;
  return <NextApproverPicker id={`pv-next-${stepIndex}`} step={state.step} totalSteps={total} when={when} value={value} error={error} onChange={onChange} />;
}

/** Who a hand-off sends the step to: the fixed approver, or the person picked. */
const receiver = (state: HandOffState, choice: string | null): ApproverOption | null =>
  state && 'step' in state ? (state.step.mode === 'fixed' ? state.step.approver : state.step.candidates.find((c) => optionId(state.step, c) === choice) ?? null) : null;

export function ChainPreview({ steps, fields, users, startAt, onStage }: { steps: StepDef[]; fields: FieldDef[]; users: UserRow[]; startAt: number; onStage(stage: number): void }) {
  const me = useAuth().user;
  const submitters = users.filter((u) => u.isActive);
  const [submitterId, setSubmitterId] = useState<number | null>(me?.userId ?? null);
  const submitter = submitters.find((u) => u.userId === submitterId) ?? null;
  const total = steps.length;
  // stage 0 is the submission, 1..total the steps, total + 1 the end
  const [stage, setStageRaw] = useState(Math.min(startAt, total));
  const [submission, setSubmission] = useState<StoredValue[] | null>(null);
  const [receivers, setReceivers] = useState<(ApproverOption | null)[]>([]); // who received each step (0-based)
  const [trail, setTrail] = useState<Decision[]>([]);
  const [choice, setChoice] = useState<string | null>(null);
  const [comments, setComments] = useState('');
  const [signature, setSignature] = useState(''); // every approver signs to approve
  const [sigError, setSigError] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const goTo = (n: number) => {
    setStageRaw(n); onStage(n);
    setChoice(null); setComments(''); setSignature(''); setSigError(false); setRejecting(false); setReason(''); setError('');
    setTrail((t) => t.filter((d) => d.stepOrder < n)); // jumping back forgets the decisions from there on
  };
  useEffect(() => { goTo(Math.min(startAt, total)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [startAt]);
  const restart = () => { setSubmission(null); setReceivers([]); setTrail([]); goTo(0); };

  // who is acting now, and so who they cannot hand on to
  const current = stage >= 1 && stage <= total ? steps[stage - 1] : null;
  const fixedApprover = (s: StepDef) => (s.chosen ? null : users.find((u) => u.userId === s.approverUserId) ?? null);
  const actor: ApproverOption | null = current ? receivers[stage - 1] ?? (() => { const u = fixedApprover(current); return u && { userId: u.userId, displayName: u.displayName, email: u.email }; })() : null;
  const nextIndex = stage <= total - 1 ? stage : null; // the step being handed on to (0-based)
  const exclude = [...new Set([submitterId, stage >= 1 ? actor?.userId : null].filter((x): x is number => !!x))];
  const handOff = useHandOff(steps, nextIndex, exclude);

  const handOn = (): boolean => {
    if (nextIndex === null) return true;
    if (!handOff || 'error' in handOff) { setError('This step cannot be handed on yet - see the message above.'); return false; }
    if (needsChoice(handOff.step, choice)) { setError(`Choose who approves "${handOff.step.name}".`); return false; }
    setError('');
    return true;
  };
  const passOn = () => {
    const to = receiver(handOff, choice);
    if (nextIndex !== null) setReceivers((r) => { const n = [...r]; n[nextIndex] = to; return n; });
  };
  const approve = () => {
    if (!current) return;
    if (!signature) return setSigError(true);
    if (!handOn()) return;
    setTrail((t) => [...t.filter((d) => d.stepOrder < stage), { stepOrder: stage, name: stepName(current, stage - 1), decision: 'Approved', actedBy: actor?.displayName ?? 'The approver', comments: comments.trim(), signature }]);
    passOn();
    const n = stage + 1;
    setStageRaw(n); onStage(n); setChoice(null); setComments(''); setSignature(''); setError('');
  };
  const reject = () => {
    if (!current) return;
    if (!reason.trim()) return setError('A rejection reason is required.');
    setTrail((t) => [...t.filter((d) => d.stepOrder < stage), { stepOrder: stage, name: stepName(current, stage - 1), decision: 'Rejected', actedBy: actor?.displayName ?? 'The approver', comments: comments.trim(), reason: reason.trim() }]);
    const n = total + 1;
    setStageRaw(n); onStage(n); setRejecting(false); setError('');
  };
  const rejected = trail.find((d) => d.decision === 'Rejected');

  const stages = ['Submission', ...steps.map((s, i) => `${i + 1}. ${stepName(s, i)}`), rejected ? 'Rejected' : 'Approved'];
  const stepper = (
    <ol className="pv-stages" aria-label="Stages of the request">
      {stages.map((label, n) => (
        <li key={n} className={`${n === stage ? 'on' : ''}${n < stage ? ' done' : ''}${n >= 1 && n <= total && stepProblem(steps[n - 1]) ? ' bad' : ''}`}>
          <button type="button" aria-current={n === stage ? 'step' : undefined} disabled={n === total + 1 && stage !== total + 1} onClick={() => goTo(n)}>{label}</button>
        </li>
      ))}
    </ol>
  );
  const submissionCard = (
    <section className="pv-card">
      <h3>Original submission <span className="tag">Read-only</span></h3>
      {submission ? <ValueList items={submission} /> : <p className="muted small">Not filled in yet. <button type="button" className="link" onClick={() => goTo(0)}>Test the submission</button> to see the approvers get real answers.</p>}
    </section>
  );
  const previous = (upTo: number) => trail.filter((d) => d.stepOrder < upTo);

  return (
    <div className="b-canvas b-live pv-chain">
      <p className="hint">Walk a pretend request through the chain as it stands here, including unsaved changes. Each stage shows what that person sees, and the hand-offs are worked out by the server exactly as for a real request. <strong>Nothing is saved and nobody is emailed.</strong></p>
      <div className="pv-bar">
        <label>Submitted by
          <select value={submitterId ?? ''} onChange={(e) => { setSubmitterId(e.target.value ? Number(e.target.value) : null); restart(); }}>
            {submitters.map((u) => <option key={u.userId} value={u.userId}>{u.displayName}{u.userId === me?.userId ? ' (you)' : ''}</option>)}
          </select>
        </label>
        <button type="button" onClick={restart}>Start again</button>
      </div>
      {stepper}

      {stage === 0 && (
        fieldProblems(fields).length > 0 || fields.length === 0 ? (
          <div><p><strong>The submission fields need fixing first:</strong></p><ul>{fieldProblems(fields).map((p) => <li key={p}>{p}</li>)}</ul>
            {total > 0 && <button type="button" onClick={() => goTo(1)}>Skip to step 1</button>}</div>
        ) : (
          <>
            <h3 className="pv-title">What {submitter?.displayName ?? 'the submitter'} sees</h3>
            <FormPreview
              fields={fields}
              check={handOn}
              onPassed={(stored) => { setSubmission(stored); passOn(); setTrail([]); setStageRaw(1); onStage(1); setChoice(null); }}
              extra={<>
                {nextIndex !== null && <HandOff state={handOff} stepIndex={0} total={total} value={choice} error={error} when="as soon as they submit" onChange={(v) => { setChoice(v); setError(''); }} />}
                <p className="small muted" style={{ marginTop: '.6rem' }}>Test submit checks the answers and the hand-off, then moves on to step 1.</p>
              </>}
            />
          </>
        )
      )}

      {current && (
        <div className="stack" style={{ gap: '1rem' }}>
          <div className="page-head">
            <div>
              <h3 className="pv-title">Step {stage} of {total}: {stepName(current, stage - 1)}</h3>
              <p className="muted small" style={{ margin: 0 }}>
                Seen by <strong>{actor?.displayName ?? (current.chosen ? `whoever ${stage === 1 ? 'the submitter' : `the approver of step ${stage - 1}`} chooses` : 'nobody yet')}</strong>
                {!receivers[stage - 1] && current.chosen && <> - <button type="button" className="link" onClick={() => goTo(stage - 1)}>test the stage before</button> to pick someone</>}.
              </p>
            </div>
            <StatusBadge status="InProgress" />
          </div>
          {stepProblem(current) && <p className="notice bad">Fix this step in Design first: {stepProblem(current)}</p>}
          <p className="small muted" style={{ margin: 0 }}>{timetable(current, users)}</p>
          {submissionCard}
          {previous(stage).length > 0 && (
            <section className="pv-card">
              <h3>Previous approvals <span className="tag">Read-only</span></h3>
              {previous(stage).map((p) => (
                <div className="prev-step" key={p.stepOrder}>
                  <div className="prev-head"><strong>Step {p.stepOrder}: {p.name}</strong><StatusBadge status={p.decision} /></div>
                  <p className="muted small">{p.actedBy}</p>
                  {p.comments && <blockquote>{p.comments}</blockquote>}
                  {p.signature && <SignatureImage value={p.signature} label={`Signature of ${p.actedBy}`} />}
                </div>
              ))}
            </section>
          )}
          <section className="pv-card card-active">
            <h3>Their section</h3>
            <div className="field"><label htmlFor="pv-comments">Comments</label><textarea id="pv-comments" rows={2} value={comments} onChange={(e) => setComments(e.target.value)} /></div>
            {rejecting ? (
              <div className="reject-box">
                <div className="field">
                  <label htmlFor="pv-reason">Reason for rejection<em className="req"> *</em></label>
                  <textarea id="pv-reason" rows={2} value={reason} aria-invalid={!!error} onChange={(e) => { setReason(e.target.value); setError(''); }} autoFocus />
                  {error && <p className="field-error">{error}</p>}
                  <p className="hint">In a real request, rejection is final: the workflow stops and the submitter is sent this reason.</p>
                </div>
                <div className="actions">
                  <button type="button" className="danger" onClick={reject}>Test rejection</button>
                  <button type="button" onClick={() => { setRejecting(false); setError(''); }}>Back</button>
                </div>
              </div>
            ) : (
              <>
                <div className="field"><label htmlFor="pv-signature">Signature<em className="req"> *</em></label><SignaturePad id="pv-signature" label="Signature" value={signature} invalid={sigError} onChange={(v) => { setSignature(v); setSigError(false); }} />{sigError && <p className="field-error" role="alert">Sign to approve.</p>}<p className="hint">Every approver signs to approve; rejecting needs no signature.</p></div>
                {nextIndex !== null && <HandOff state={handOff} stepIndex={nextIndex} total={total} value={choice} error={error} when="as soon as they approve" onChange={(v) => { setChoice(v); setError(''); }} />}
                {nextIndex === null && error && <p className="field-error" role="alert">{error}</p>}
                <div className="actions">
                  <button type="button" className="primary" disabled={!!stepProblem(current)} onClick={approve}>{nextIndex !== null ? 'Test approve and send on' : 'Test approve'}</button>
                  <button type="button" className="danger-outline" disabled={!!stepProblem(current)} onClick={() => { setRejecting(true); setError(''); }}>Test reject…</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {stage === total + 1 && (
        <div className="b-result" role="status">
          <p><strong>{rejected ? `Rejected at step ${rejected.stepOrder}.` : 'Approved - the request would be complete.'}</strong> {rejected ? `${submitter?.displayName ?? 'The submitter'} would be emailed the reason: "${rejected.reason}".` : `${submitter?.displayName ?? 'The submitter'} would be emailed that it was approved, and the PDF would be archived.`}</p>
          <ul style={{ margin: '.4rem 0 0', paddingLeft: '1.2rem' }}>
            <li>Submitted by {submitter?.displayName ?? 'the submitter'}{submission ? '' : ' (form not filled in)'}</li>
            {trail.map((d) => <li key={d.stepOrder}>Step {d.stepOrder}, {d.name}: {d.decision.toLowerCase()} by {d.actedBy}{d.comments && ` - "${d.comments}"`}</li>)}
          </ul>
          <p className="small muted" style={{ marginTop: '.5rem' }}>Nothing was saved and nobody was emailed.</p>
        </div>
      )}
    </div>
  );
}
