// Submitter portal: my submissions, request detail with progress tracker, new request (optionally pre-filled from an earlier one).
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, download } from '../api';
import { FieldGrid, FieldInput, StatusBadge, ValueList, applyLookups, fmtDateTime, initialValues, toPayload, withLookupOptions, type FieldDef, type FieldValue, type GridValue, type Lookups, type Values } from '../fields';
import { NextApproverPicker, choicePayload, needsChoice, type StepHandOff } from '../approvers';
import { useLoad } from '../hooks';

/** Compact "● ● ◐ ○" tracker: one segment per approval step. */
export function StepDots({ total, current, status, rejectedAt }: { total: number; current: number | null; status: string; rejectedAt?: number | null }) {
  return (
    <span className="dots" role="img" aria-label={current ? `Step ${current} of ${total}` : status}>
      {Array.from({ length: total }, (_, i) => {
        const n = i + 1;
        const state =
          status === 'Approved' ? 'done'
          : status === 'Rejected' ? (n < (rejectedAt ?? 0) ? 'done' : n === rejectedAt ? 'bad' : 'todo')
          : status === 'Cancelled' ? 'todo'
          : n < (current ?? 0) ? 'done' : n === current ? 'now' : 'todo';
        return <i key={n} className={`dot dot-${state}`} />;
      })}
    </span>
  );
}

interface MyRow {
  requestId: number; requestNumber: string; formId: number; formName: string; status: string; currentStep: number | null; currentStepName: string | null;
  totalSteps: number; waitingOn: string | null; submittedAt: string; closedAt: string | null;
  rejection: { reason: string; stepOrder: number; stepName: string } | null; pdfAvailable: boolean;
}

export function MySubmissions() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const page = Number(params.get('page') ?? 1);
  const { data, error } = useLoad<{ total: number; pageSize: number; requests: MyRow[] }>(`/my/requests?page=${page}${status ? `&status=${status}` : ''}`);
  const [pdfError, setPdfError] = useState('');
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const go = (next: Record<string, string>) => setParams(Object.fromEntries(Object.entries({ status, ...next }).filter(([, v]) => v)), { replace: true });

  return (
    <section className="card">
      <div className="prev-head" style={{ marginBottom: '1rem' }}>
        <h2 style={{ margin: 0 }}>My submissions</h2>
        <div className="seg" role="group" aria-label="Filter by status">
          {[['', 'All'], ['InProgress', 'In progress'], ['Approved', 'Approved'], ['Rejected', 'Rejected']].map(([v, label]) => (
            <button key={v} className={status === v ? 'on' : ''} onClick={() => go({ status: v, page: '' })}>{label}</button>
          ))}
        </div>
      </div>
      {pdfError && <p className="notice bad">{pdfError}</p>}
      {error ? <p className="notice bad">{error}</p> : !data ? <p className="muted">Loading…</p> : data.requests.length === 0 ? (
        <p className="muted">{status ? 'Nothing with this status.' : 'You have not submitted anything yet.'}</p>
      ) : (
        <>
          <ul className="sub-list">
            {data.requests.map((r) => (
              <li key={r.requestId}>
                <div className="sub-main">
                  <Link to={`/requests/${r.requestId}`} className="sub-title">{r.requestNumber}</Link>
                  <span className="muted"> · {r.formName} · {fmtDateTime(r.submittedAt)}</span>
                  <div className="sub-progress">
                    <StepDots total={r.totalSteps} current={r.currentStep} status={r.status} rejectedAt={r.rejection?.stepOrder} />
                    <span className="small">
                      {r.status === 'InProgress' && <>Step {r.currentStep} of {r.totalSteps} ({r.currentStepName}), waiting on <strong>{r.waitingOn}</strong></>}
                      {r.status === 'Approved' && <>All {r.totalSteps} steps approved · {fmtDateTime(r.closedAt)}</>}
                      {r.status === 'Rejected' && r.rejection && <span className="field-error">Rejected at step {r.rejection.stepOrder} ({r.rejection.stepName}): {r.rejection.reason}</span>}
                      {r.status === 'Cancelled' && <>Cancelled by an administrator</>}
                    </span>
                  </div>
                </div>
                <div className="sub-side">
                  <StatusBadge status={r.status} />
                  {r.pdfAvailable && (
                    <button className="link" onClick={() => { setPdfError(''); download(`/my/requests/${r.requestId}/pdf`, `${r.requestNumber}.pdf`).catch((e) => setPdfError(e.message)); }}>
                      {r.status === 'Rejected' ? 'Archived PDF' : 'Final PDF'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {pages > 1 && (
            <div className="actions pager">
              <button disabled={page <= 1} onClick={() => go({ page: String(page - 1) })}>← Newer</button>
              <span className="muted small">Page {page} of {pages}</span>
              <button disabled={page >= pages} onClick={() => go({ page: String(page + 1) })}>Older →</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------
interface MyRequestDetail {
  requestId: number; requestNumber: string; formId: number; formName: string; status: string; submittedAt: string; closedAt: string | null;
  progress: { currentStep: number | null; totalSteps: number; waitingOn: string | null; label: string };
  rejection: { reason: string; stepOrder: number; stepName: string | null; rejectedBy: string | null; rejectedAt: string | null } | null;
  cancelReason: string | null; pdfAvailable: boolean; data: FieldValue[];
  steps: { stepOrder: number; name: string; status: string; approver: string; actedAt: string | null; comments?: string | null; responses?: FieldValue[] }[];
}

export function NewRequestPage() {
  const { formId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [form, setForm] = useState<{ form: { name: string; description: string | null }; fields: FieldDef[]; lookups?: Lookups; firstStep?: StepHandOff | null } | null>(null);
  const [firstApprover, setFirstApprover] = useState<string | null>(null); // who the submitter picked for step 1, on a chosen step
  const [values, setValues] = useState<Values>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [copiedFrom, setCopiedFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const from = params.get('from');

  useEffect(() => {
    let live = true;
    (async () => {
      const loaded = await api<NonNullable<typeof form>>(`/forms/${formId}`);
      if (!live) return;
      const f = { ...loaded, fields: withLookupOptions(loaded.fields, loaded.lookups) };
      setForm(f);
      setValues(applyLookups(f.fields, initialValues(f.fields), f.lookups));
      if (!from) return;
      // Pre-fill from one of MY earlier requests (the API only returns my own). Fields that no longer exist or changed type are skipped.
      const prev = (await api<{ request: MyRequestDetail }>(`/my/requests/${from}`).catch(() => null))?.request;
      if (!live || !prev) return;
      const next: Values = {};
      for (const def of f.fields) {
        const old = prev.data.find((d) => d.key === def.key && d.type === def.type);
        if (old?.value == null || def.type === 'sigpad') continue; // a signature is never copied: it has to be made again
        if (def.type === 'checkbox') next[def.key] = old.value === 'true';
        else if (def.type === 'multiselect') { try { next[def.key] = JSON.parse(old.value) as string[]; } catch { /* skip */ } }
        else if (def.type === 'grid') {
          // only what was typed into columns that still exist; calculated cells are worked out again
          const cols = (def.props?.columns ?? []).filter((c) => c.type !== 'calc');
          try { next[def.key] = (JSON.parse(old.value) as GridValue).rows.map((r) => Object.fromEntries(cols.filter((c) => r[c.key] != null).map((c) => [c.key, r[c.key] as string]))); } catch { /* skip */ }
        }
        else next[def.key] = old.value;
      }
      setValues(applyLookups(f.fields, next, f.lookups));
      setCopiedFrom(prev.requestNumber);
    })().catch(() => live && setFormError('This form is not available.'));
    return () => void (live = false);
  }, [formId, from]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    if (needsChoice(form.firstStep, firstApprover)) return setErrors({ firstApproverUserId: `Choose who approves "${form.firstStep!.name}".` });
    setBusy(true);
    setErrors({});
    setFormError('');
    try {
      const created = await api<{ requestId: number }>(`/forms/${formId}/requests`, { method: 'POST', body: { values: toPayload(form.fields, values), ...choicePayload(form.firstStep, firstApprover, 'first') } });
      navigate(`/requests/${created.requestId}?submitted=1`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation_failed') {
        setErrors(err.fieldErrors);
        setFormError('Please fix the highlighted fields.');
      } else setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Nothing was submitted.');
      setBusy(false);
    }
  };

  if (!form) return formError ? <div className="card"><p className="notice bad">{formError}</p></div> : <p className="muted center">Loading…</p>;
  const firstStep = form.firstStep ?? null;
  return (
    <form className="card" onSubmit={submit} noValidate>
      {/* the form's own layout carries its title: the name is kept for screen readers only */}
      <h1 className="sr-only">{form.form.name}</h1>
      {copiedFrom && <p className="notice">Pre-filled from {copiedFrom}. This will be a brand-new request - review the details before submitting.</p>}
      {formError && <p className="notice bad" role="alert">{formError}</p>}
      <FieldGrid defs={form.fields}>
        {(f) => <FieldInput def={f} value={values[f.key]} error={errors[f.key]} disabled={busy} onChange={(v) => setValues((s) => applyLookups(form.fields, { ...s, [f.key]: v }, form.lookups))} />}
      </FieldGrid>
      {firstStep && <NextApproverPicker id="first-approver" step={firstStep} value={firstApprover} error={errors.firstApprover ?? errors.firstApproverUserId ?? errors.firstApproverKey} disabled={busy} onChange={setFirstApprover} />}
      <div className="actions">
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Submit for approval'}</button>
        <Link to={'/'}>Cancel</Link>
      </div>
    </form>
  );
}

export function RequestPage() {
  const { requestId } = useParams();
  const [params] = useSearchParams();
  const { data, error } = useLoad<{ request: MyRequestDetail }>(`/my/requests/${requestId}`);
  const [pdfError, setPdfError] = useState('');

  if (error) return <div className="card"><p className="notice bad">Request not found.</p><Link to={'/'}>Back</Link></div>;
  if (!data) return <p className="muted center">Loading…</p>;
  const r = data.request;
  const closed = r.status === 'Approved' || r.status === 'Rejected';

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">{r.formName}</p>
          <h1>{r.requestNumber}</h1>
          <p className="muted">Submitted {fmtDateTime(r.submittedAt)}{r.closedAt && ` · closed ${fmtDateTime(r.closedAt)}`}</p>
        </div>
        <StatusBadge status={r.status} />
      </div>

      {params.get('submitted') && r.status === 'InProgress' && <p className="notice ok" role="status">Submitted. We have emailed you a confirmation and notified the first approver.</p>}
      {r.status === 'InProgress' && <p className="notice"><strong>{r.progress.label}.</strong> You will be emailed when a final decision is made.</p>}
      {r.status === 'Approved' && <p className="notice ok"><strong>Fully approved.</strong> All {r.progress.totalSteps} approval steps are complete.</p>}
      {r.rejection && (
        <div className="notice bad">
          <p><strong>Rejected at step {r.rejection.stepOrder}{r.rejection.stepName && ` (${r.rejection.stepName})`}</strong>{r.rejection.rejectedBy && ` by ${r.rejection.rejectedBy}`}{r.rejection.rejectedAt && ` on ${fmtDateTime(r.rejection.rejectedAt)}`}</p>
          <p><strong>Reason:</strong> {r.rejection.reason}</p>
          <p style={{ margin: 0 }}>This decision is final and the request cannot be reopened. To pursue it again, <Link to={`/requests/new/${r.formId}?from=${r.requestId}`}>start a new request using these details</Link>.</p>
        </div>
      )}
      {r.cancelReason && <p className="notice bad"><strong>Cancelled by an administrator:</strong> {r.cancelReason}</p>}

      {closed && (
        <div className="actions">
          <button className="primary" disabled={!r.pdfAvailable} onClick={() => { setPdfError(''); download(`/my/requests/${requestId}/pdf`, `${r.requestNumber}.pdf`).catch((e) => setPdfError(e.message)); }}>
            Download {r.status === 'Rejected' ? 'archived' : 'final'} PDF
          </button>
          {!r.pdfAvailable && <span className="muted small">The PDF is being prepared - refresh in a moment.</span>}
          {pdfError && <span className="field-error">{pdfError}</span>}
        </div>
      )}

      <section className="card">
        <h2>Progress</h2>
        <ol className="stepper">
          {r.steps.map((s) => (
            <li key={s.stepOrder} className={`stepper-${s.status.toLowerCase()}`}>
              <span className="stepper-n">{s.status === 'Approved' ? '✓' : s.status === 'Rejected' ? '✕' : s.stepOrder}</span>
              <div>
                <div className="prev-head"><strong>{s.name}</strong><StatusBadge status={s.status} /></div>
                <p className="muted small" style={{ margin: 0 }}>
                  {s.status === 'Active' ? `Waiting on ${s.approver}` : s.actedAt ? `${s.approver} · ${fmtDateTime(s.actedAt)}` : s.approver}
                </p>
                {s.responses && s.responses.length > 0 && <div style={{ marginTop: '.5rem' }}><ValueList items={s.responses} /></div>}
                {s.comments && <blockquote>{s.comments}</blockquote>}
              </div>
            </li>
          ))}
        </ol>
      </section>
      <section className="card">
        <h2>Your submission <span className="tag">Read-only</span></h2>
        <ValueList items={r.data} />
      </section>
      <p><Link to={'/'}>← My submissions</Link></p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
export function AccountPage() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const digits = (set: (v: string) => void) => (e: { target: { value: string } }) => set(e.target.value.replace(/\D/g, '').slice(0, 6));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setMsg({ ok: false, text: 'The two new keys do not match.' });
    try {
      await api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } });
      setCurrent(''); setNext(''); setConfirm('');
      setMsg({ ok: true, text: 'Password key changed. Other devices have been signed out.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.details[0]?.message ?? err.message : 'Something went wrong.' });
    }
  };
  const field = { className: 'digits', type: 'password', inputMode: 'numeric' as const, maxLength: 6, required: true };
  return (
    <form className="card" onSubmit={submit} style={{ maxWidth: 440 }}>
      <h1>Change password key</h1>
      {msg && <p className={`notice ${msg.ok ? 'ok' : 'bad'}`} role="status">{msg.text}</p>}
      <div className="field"><label htmlFor="cp">Current key</label><input id="cp" {...field} autoComplete="current-password" value={current} onChange={digits(setCurrent)} /></div>
      <div className="field"><label htmlFor="np">New 6-digit key</label><input id="np" {...field} autoComplete="new-password" value={next} onChange={digits(setNext)} /><p className="hint">Digits only. Obvious keys such as 123456 or 111111 are refused.</p></div>
      <div className="field"><label htmlFor="np2">Repeat the new key</label><input id="np2" {...field} autoComplete="new-password" value={confirm} onChange={digits(setConfirm)} /></div>
      <button className="primary" type="submit" disabled={current.length !== 6 || next.length !== 6 || confirm.length !== 6}>Change key</button>
      <p className="muted small">Forgotten your current key? Sign out and choose "Forgot your key?" on the sign-in page.</p>
    </form>
  );
}
