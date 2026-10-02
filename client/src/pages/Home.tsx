import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../api';
import { NextApproverPicker, choicePayload, needsChoice, optionId, type StepHandOff } from '../approvers';
import { useAuth } from '../auth';
import { waitedFor } from '../dates';
import { fmtDateTime } from '../fields';
import { useLoad } from '../hooks';
import { SignaturePad } from '../sigpad';
import { MySubmissions } from './Requests';

interface Pending {
  requestStepId: number; requestId: number; requestNumber: string; formName: string; submitterName: string; stepOrder: number; totalSteps: number; stepName: string;
  activatedAt: string; dueAt: string | null; overdue: boolean;
  /** approving means choosing who approves next: the batch panel asks for it, per request */
  choosesNext: boolean;
  nextStep: StepHandOff | null;
  preview: { label: string; value: string }[];
}
interface FormSummary { formId: number; name: string; description: string | null }
interface BatchResult { requestStepId: number; ok: boolean; requestStatus?: string; nextStepOrder?: number | null; message?: string }

const MAX_BATCH = 50;

export function HomePage() {
  const { user } = useAuth();
  const isApprover = user!.roles.includes('Approver') || user!.roles.includes('Admin');
  const isSubmitter = user!.roles.includes('Submitter');
  const forms = useLoad<{ forms: FormSummary[] }>(isSubmitter ? '/forms' : null);
  const pending = useLoad<{ approvals: Pending[] }>(isApprover ? '/approvals/pending' : null);
  const sentBack = useLoad<{ total: number }>(isSubmitter ? '/my/requests?status=Returned&pageSize=1' : null);

  if (!isApprover && !isSubmitter) return <div className="card"><p className="muted">Your account has no role assigned yet. Please contact your administrator.</p></div>;
  return (
    <div className="stack">
      {(!isApprover || pending.data) && (!isSubmitter || sentBack.data) && (
        <Lead waiting={pending.data?.approvals.length ?? 0} sentBack={sentBack.data?.total ?? 0} submitter={isSubmitter} />
      )}
      <div className={`home${isSubmitter ? '' : ' single'}`}>
        <div className="home-main">
          {isApprover && <WaitingForMe pending={pending} />}
          {isSubmitter && <MySubmissions />}
        </div>
        {isSubmitter && (
          <aside className="card bare home-side">
            <h2>Start a new request</h2>
            <div className="sheet">
              {!forms.data ? <p className="muted">Loading…</p> : forms.data.forms.length === 0 ? <p className="muted">No forms are available yet.</p> : (
                <div className="form-cards">
                  {forms.data.forms.map((f) => (
                    <Link key={f.formId} to={`/requests/new/${f.formId}`} className="form-card">
                      <strong>{f.name}</strong>
                      {f.description && <span className="muted small">{f.description}</span>}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

/** The first thing on the page: what needs this person, in one sentence. */
function Lead({ waiting, sentBack, submitter }: { waiting: number; sentBack: number; submitter: boolean }) {
  const many = (n: number) => (n === 1 ? 'One' : String(n));
  return (
    <div className="lead">
      {waiting > 0 ? (
        <>
          <h1>{waiting} request{waiting === 1 ? ' is' : 's are'} waiting for your approval</h1>
          {sentBack > 0 && <p>And {many(sentBack).toLowerCase()} of your own {sentBack === 1 ? 'was' : 'were'} sent back to you for changes.</p>}
        </>
      ) : sentBack > 0 ? (
        <>
          <h1>{many(sentBack)} of your requests need{sentBack === 1 ? 's' : ''} your changes</h1>
          <p>An approver sent {sentBack === 1 ? 'it' : 'them'} back. Make the changes and resubmit, and {sentBack === 1 ? 'it goes' : 'they go'} straight back to the same step.</p>
        </>
      ) : (
        <>
          <h1>Nothing is waiting for you</h1>
          <p>{submitter ? 'Start a new request, or follow the ones you have sent.' : 'Requests appear here when they reach your step.'}</p>
        </>
      )}
    </div>
  );
}

/** "Waiting for my approval", with tick boxes to approve several at once under one signature. */
function WaitingForMe({ pending }: { pending: { data: { approvals: Pending[] } | null; error: string; reload(): void } }) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState(false); // the batch panel
  const [comments, setComments] = useState('');
  const [signature, setSignature] = useState('');
  const [choices, setChoices] = useState<Record<number, string>>({}); // who each request goes to next, where that is chosen
  const [notes, setNotes] = useState<Record<number, string>>({}); // a comment for one request only, added after the shared one
  const [noteOpen, setNoteOpen] = useState<Set<number>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ results: BatchResult[]; names: Map<number, Pending> } | null>(null);

  const rows = pending.data?.approvals ?? [];
  const pickable = rows;
  const chosen = rows.filter((r) => picked.has(r.requestStepId));
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else if (n.size < MAX_BATCH) n.add(id); return n; });
  const all = pickable.length > 0 && pickable.every((r) => picked.has(r.requestStepId));
  const toggleAll = () => setPicked(all ? new Set() : new Set(pickable.slice(0, MAX_BATCH).map((r) => r.requestStepId)));

  const unchosen = chosen.filter((r) => needsChoice(r.nextStep, choices[r.requestStepId] ?? null));
  const approve = async () => {
    setError('');
    if (unchosen.length) return setError(`Choose who each request goes to next (${unchosen.map((r) => r.requestNumber).join(', ')}).`);
    if (!signature) return setError('Sign to approve.');
    // { nextApproverUserId } or { nextApproverKey } per request, as the server's batch takes it: { userId } or { key }
    const next = Object.fromEntries(chosen.filter((r) => r.nextStep?.mode === 'chosen').map((r) => {
      const c = choicePayload(r.nextStep, choices[r.requestStepId] ?? null, 'next') as { nextApproverUserId?: number; nextApproverKey?: string };
      return [r.requestStepId, { userId: c.nextApproverUserId, key: c.nextApproverKey }];
    }));
    setBusy(true);
    try {
      const res = await api<{ approved: number; results: BatchResult[] }>('/approvals/batch-approve', {
        method: 'POST',
        body: { requestStepIds: chosen.map((r) => r.requestStepId), comments: comments.trim() || undefined, signature: JSON.parse(signature), next,
          notes: Object.fromEntries(chosen.filter((r) => notes[r.requestStepId]?.trim()).map((r) => [r.requestStepId, notes[r.requestStepId].trim()])) },
      });
      setDone({ results: res.results, names: new Map(chosen.map((r) => [r.requestStepId, r])) });
      setPicked(new Set());
      setOpen(false);
      setComments('');
      setSignature('');
      setChoices({});
      setNotes({});
      setNoteOpen(new Set());
      pending.reload();
    } catch (e) {
      setError(e instanceof ApiError ? (Object.values(e.fieldErrors)[0] ?? e.message) : 'Something went wrong. Nothing was approved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card bare">
      <h2>Waiting for my approval</h2>

      {done && (
        <div className={`notice ${done.results.every((r) => r.ok) ? 'ok' : ''}`} role="status" style={{ marginBottom: '1rem' }}>
          <p style={{ marginTop: 0 }}><strong>{done.results.filter((r) => r.ok).length} of {done.results.length} approved.</strong></p>
          <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
            {done.results.map((r) => {
              const p = done.names.get(r.requestStepId);
              return (
                <li key={r.requestStepId}>
                  {p?.requestNumber}: {r.ok
                    ? (r.requestStatus === 'Approved' ? 'approved - that was the last step' : `approved, moved on to step ${r.nextStepOrder}`)
                    : <span className="field-error">not approved - {r.message}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {open && (
        <div className="batch-box">
          <h3 style={{ marginTop: 0 }}>Approve {chosen.length} request{chosen.length === 1 ? '' : 's'}</h3>
          <p className="muted small" style={{ marginTop: 0 }}>Check each one. Anything that needs a closer look: open it instead, and untick it here.</p>
          <ul className="batch-list">
            {chosen.map((r) => (
              <li key={r.requestStepId}>
                <div className="prev-head">
                  <span><Link to={`/approvals/${r.requestStepId}`} className="reqno">{r.requestNumber}</Link> <strong>{r.formName}</strong> from {r.submitterName}, step {r.stepOrder} of {r.totalSteps}</span>
                  <button className="link" disabled={busy} onClick={() => toggle(r.requestStepId)}>Remove</button>
                </div>
                {r.preview.length > 0 && <p className="muted small" style={{ margin: '.2rem 0 0' }}>{r.preview.map((f) => `${f.label}${/[?:]$/.test(f.label) ? '' : ':'} ${f.value}`).join('; ')}</p>}
                {r.choosesNext && r.nextStep && (
                  <div style={{ marginTop: '.5rem' }}>
                    <NextApproverPicker id={`next-${r.requestStepId}`} step={r.nextStep} totalSteps={r.totalSteps} when="as soon as you approve" value={choices[r.requestStepId] ?? null} disabled={busy}
                      onChange={(v) => setChoices((c) => ({ ...c, [r.requestStepId]: v }))} />
                    <UseForAll row={r} rows={chosen} choices={choices} disabled={busy} onApply={setChoices} />
                  </div>
                )}
                {noteOpen.has(r.requestStepId) || notes[r.requestStepId] ? (
                  <div className="field" style={{ margin: '.5rem 0 0' }}>
                    <label htmlFor={`note-${r.requestStepId}`}>Comment for {r.requestNumber} only</label>
                    <textarea id={`note-${r.requestStepId}`} rows={2} maxLength={4000} value={notes[r.requestStepId] ?? ''} disabled={busy} autoFocus={!notes[r.requestStepId]}
                      onChange={(e) => setNotes((n) => ({ ...n, [r.requestStepId]: e.target.value }))} />
                  </div>
                ) : (
                  <button type="button" className="link small" disabled={busy} onClick={() => setNoteOpen((o) => new Set(o).add(r.requestStepId))}>Add a comment for this request</button>
                )}
              </li>
            ))}
          </ul>
          <div className="field">
            <label htmlFor="batch-comments">Comment for all of them</label>
            <textarea id="batch-comments" rows={2} maxLength={4000} value={comments} disabled={busy} onChange={(e) => setComments(e.target.value)} />
            <p className="hint">Optional. Saved on every request above; a request's own comment is added after it.</p>
          </div>
          <div className="field">
            <label htmlFor="batch-signature">Your signature<em className="req"> *</em></label>
            <SignaturePad id="batch-signature" label="Your signature" value={signature} disabled={busy} invalid={!!error && !signature} onChange={(v) => { setSignature(v); setError(''); }} />
            <p className="hint">One signature for all of them; it is saved with each approval and printed in each PDF.</p>
          </div>
          {error && <p className="notice bad" role="alert">{error}</p>}
          <div className="actions">
            <button className="primary" disabled={busy || chosen.length === 0} onClick={() => void approve()}>{busy ? 'Approving…' : `Approve ${chosen.length} request${chosen.length === 1 ? '' : 's'}`}</button>
            <button disabled={busy} onClick={() => setOpen(false)}>Back</button>
          </div>
        </div>
      )}

      {!open && (
        <div className="sheet">
          {pending.error ? <p className="notice bad">{pending.error}</p> : !pending.data ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="muted">Nothing is waiting on you.</p> : (
            <>
              {rows.map((p) => {
                // the first thing the submitter filled in says what the request is about
                const about = p.preview[0]?.value;
                return (
                  <div key={p.requestStepId} className={`wait-row${pickable.length > 1 ? '' : ' nopick'}`}>
                    {pickable.length > 1 && <input type="checkbox" aria-label={`Select ${p.requestNumber}`} checked={picked.has(p.requestStepId)} onChange={() => toggle(p.requestStepId)} />}
                    <div className="wait-what">
                      <strong><Link to={`/approvals/${p.requestStepId}`} className="reqno">{p.requestNumber}</Link> &nbsp;{about ?? p.formName}</strong>
                      <span>{about ? `${p.formName} from ` : 'From '}{p.submitterName}, step {p.stepOrder} of {p.totalSteps} ({p.stepName})</span>
                    </div>
                    <div className={`wait-age${p.overdue ? ' late' : ''}`} title={`Waiting since ${fmtDateTime(p.activatedAt)}`}>Waiting {waitedFor(p.activatedAt)}{p.overdue && ', overdue'}</div>
                    <Link to={`/approvals/${p.requestStepId}`} className="button">Review</Link>
                  </div>
                );
              })}
              {pickable.length > 1 && (
                <div className="wait-foot">
                  <label className="check"><input type="checkbox" aria-label="Select all" checked={all} onChange={toggleAll} /> Select all</label>
                  <button className="primary" disabled={chosen.length === 0} onClick={() => { setOpen(true); setDone(null); }}>
                    Approve selected{chosen.length ? ` (${chosen.length})` : ''}
                  </button>
                  <span>Tick the requests to approve together, then sign once.</span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

/** After choosing on one request: give the same person to every other request in the batch that can go to them. */
function UseForAll({ row, rows, choices, disabled, onApply }: {
  row: Pending; rows: Pending[]; choices: Record<number, string>; disabled: boolean; onApply(next: Record<number, string>): void;
}) {
  const value = choices[row.requestStepId];
  if (!value || !row.nextStep) return null;
  const person = row.nextStep.candidates.find((c) => optionId(row.nextStep!, c) === value);
  const others = rows.filter((o) => o !== row && o.nextStep?.mode === 'chosen' && choices[o.requestStepId] !== value
    && o.nextStep.candidates.some((c) => optionId(o.nextStep!, c) === value));
  if (!person || others.length === 0) return null;
  return (
    <button type="button" className="link small" disabled={disabled}
      onClick={() => onApply({ ...choices, ...Object.fromEntries(others.map((o) => [o.requestStepId, value])) })}>
      Send the other {others.length === 1 ? 'one' : others.length} to {person.displayName} too
    </button>
  );
}
