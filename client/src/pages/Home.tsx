import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../api';
import { useAuth } from '../auth';
import { waitedFor } from '../dates';
import { fmtDateTime } from '../fields';
import { useLoad } from '../hooks';
import { SignaturePad } from '../sigpad';
import { MySubmissions } from './Requests';

interface Pending {
  requestStepId: number; requestId: number; requestNumber: string; formName: string; submitterName: string; stepOrder: number; totalSteps: number; stepName: string;
  activatedAt: string; dueAt: string | null; overdue: boolean;
  /** approving means choosing who approves next: one at a time only */
  choosesNext: boolean;
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

  return (
    <div className="stack">
      {isApprover && <WaitingForMe />}

      {isSubmitter && (
        <>
          <section className="card">
            <h2>Start a new request</h2>
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
          </section>
          <MySubmissions />
        </>
      )}

      {!isApprover && !isSubmitter && <div className="card"><p className="muted">Your account has no role assigned yet. Please contact your administrator.</p></div>}
    </div>
  );
}

/** "Waiting for my approval", with tick boxes to approve several at once under one signature. */
function WaitingForMe() {
  const pending = useLoad<{ approvals: Pending[] }>('/approvals/pending');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState(false); // the batch panel
  const [comments, setComments] = useState('');
  const [signature, setSignature] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ results: BatchResult[]; names: Map<number, Pending> } | null>(null);

  const rows = pending.data?.approvals ?? [];
  const pickable = rows.filter((r) => !r.choosesNext);
  const chosen = rows.filter((r) => picked.has(r.requestStepId));
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else if (n.size < MAX_BATCH) n.add(id); return n; });
  const all = pickable.length > 0 && pickable.every((r) => picked.has(r.requestStepId));
  const toggleAll = () => setPicked(all ? new Set() : new Set(pickable.slice(0, MAX_BATCH).map((r) => r.requestStepId)));

  const approve = async () => {
    setError('');
    if (!signature) return setError('Sign to approve.');
    setBusy(true);
    try {
      const res = await api<{ approved: number; results: BatchResult[] }>('/approvals/batch-approve', {
        method: 'POST',
        body: { requestStepIds: chosen.map((r) => r.requestStepId), comments: comments.trim() || undefined, signature: JSON.parse(signature) },
      });
      setDone({ results: res.results, names: new Map(chosen.map((r) => [r.requestStepId, r])) });
      setPicked(new Set());
      setOpen(false);
      setComments('');
      setSignature('');
      pending.reload();
    } catch (e) {
      setError(e instanceof ApiError ? (e.fieldErrors.signature ?? e.message) : 'Something went wrong. Nothing was approved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <div className="prev-head" style={{ marginBottom: '.75rem' }}>
        <h2 style={{ margin: 0 }}>Waiting for my approval</h2>
        {pickable.length > 1 && !open && (
          <button className="primary" disabled={chosen.length === 0} onClick={() => { setOpen(true); setDone(null); }}>
            Approve selected{chosen.length ? ` (${chosen.length})` : ''}
          </button>
        )}
      </div>

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
                  <span><Link to={`/approvals/${r.requestStepId}`}>{r.requestNumber}</Link> · {r.formName} · from {r.submitterName} · step {r.stepOrder} of {r.totalSteps}</span>
                  <button className="link" disabled={busy} onClick={() => toggle(r.requestStepId)}>Remove</button>
                </div>
                {r.preview.length > 0 && <p className="muted small" style={{ margin: '.2rem 0 0' }}>{r.preview.map((f) => `${f.label}${/[?:]$/.test(f.label) ? '' : ':'} ${f.value}`).join(' · ')}</p>}
              </li>
            ))}
          </ul>
          <div className="field">
            <label htmlFor="batch-comments">Comments (added to each)</label>
            <textarea id="batch-comments" rows={2} maxLength={4000} value={comments} disabled={busy} onChange={(e) => setComments(e.target.value)} />
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

      {pending.error ? <p className="notice bad">{pending.error}</p> : !pending.data ? <p className="muted">Loading…</p> : rows.length === 0 ? <p className="muted">Nothing is waiting on you.</p> : !open && (
        <table>
          <thead>
            <tr>
              {pickable.length > 1 && <th style={{ width: '2rem' }}><input type="checkbox" aria-label="Select all" checked={all} onChange={toggleAll} /></th>}
              <th>Request</th><th>Form</th><th>Submitted by</th><th>Step</th><th>Waiting since</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.requestStepId}>
                {pickable.length > 1 && (
                  <td>
                    <input type="checkbox" aria-label={`Select ${p.requestNumber}`} checked={picked.has(p.requestStepId)} disabled={p.choosesNext}
                      title={p.choosesNext ? 'Open it to approve: you choose who approves next' : undefined} onChange={() => toggle(p.requestStepId)} />
                  </td>
                )}
                <td><Link to={`/approvals/${p.requestStepId}`}>{p.requestNumber}</Link></td>
                <td>{p.formName}</td>
                <td>{p.submitterName}</td>
                <td>{p.stepOrder} of {p.totalSteps} · {p.stepName}</td>
                <td>{fmtDateTime(p.activatedAt)} <span className="muted small">({waitedFor(p.activatedAt)})</span></td>
                <td>
                  {p.overdue && <span className="badge badge-rejected">Overdue</span>}
                  {p.choosesNext && pickable.length > 1 && <span className="muted small"> open to choose who's next</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
