// Submitter portal: my submissions, request detail with progress tracker, new request (optionally pre-filled from an earlier one).
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, download } from '../api';
import { FieldGrid, FieldInput, StatusBadge, ValueList, applyLookups, fmtDateTime, initialValues, toPayload, withLookupOptions, type FieldDef, type FieldValue, type GridValue, type Lookups, type Values } from '../fields';
import { NextApproverPicker, choicePayload, needsChoice, type StepHandOff } from '../approvers';
import { useAuth } from '../auth';
import { useLoad } from '../hooks';
import { myTimeZone, waitedFor } from '../dates';
import { ChangeList, type SendBack } from '../sendback';
import { SignOff, type SignOffStep } from '../signoff';

interface MyRow {
  steps: SignOffStep[];
  requestId: number; requestNumber: string; formId: number; formName: string; status: string; currentStep: number | null; currentStepName: string | null;
  totalSteps: number; waitingOn: string | null; waitingSince: string | null; submittedAt: string; closedAt: string | null;
  sentBack: { reason: string; returnedBy: string; returnedAt: string } | null;
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
    <section className="card bare">
      <h2>My submissions</h2>
      {/* the filter is the tabs of the folder the list sits in */}
      <div className="tabs" role="group" aria-label="Filter by status">
        {[['', 'All'], ['Returned', 'Needs my changes'], ['InProgress', 'In progress'], ['Approved', 'Approved'], ['Rejected', 'Rejected']].map(([v, label]) => (
          <button key={v} className={status === v ? 'on' : ''} aria-pressed={status === v} onClick={() => go({ status: v, page: '' })}>{label}</button>
        ))}
      </div>
      <div className="sheet">
        {pdfError && <p className="notice bad">{pdfError}</p>}
        {error ? <p className="notice bad">{error}</p> : !data ? <p className="muted">Loading…</p> : data.requests.length === 0 ? (
          <p className="muted">{status ? 'Nothing with this status.' : 'You have not submitted anything yet. Choose a form under "Start a new request".'}</p>
        ) : (
          <>
            {data.requests.map((r) => (
              <article key={r.requestId} className="req-row">
                <div className="req-head">
                  <Link to={`/requests/${r.requestId}`} className="reqno">{r.requestNumber}</Link>
                  <strong>{r.formName}</strong>
                  <span>submitted {fmtDateTime(r.submittedAt)}</span>
                </div>
                <div className="req-side">
                  {r.sentBack ? <Link to={`/requests/${r.requestId}/edit`}><strong>Make the changes</strong></Link> : <StatusBadge status={r.status} />}
                  {r.pdfAvailable && (
                    <button className="link" onClick={() => { setPdfError(''); download(`/my/requests/${r.requestId}/pdf`, `${r.requestNumber}.pdf`).catch((e) => setPdfError(e.message)); }}>
                      {r.status === 'Rejected' ? 'Archived PDF' : 'Final PDF'}
                    </button>
                  )}
                </div>
                {r.status === 'InProgress' && r.sentBack && <p className="req-note back"><strong>Sent back to you</strong> by {r.sentBack.returnedBy}: {r.sentBack.reason}</p>}
                {r.status === 'Rejected' && r.rejection && (
                  <p className="req-note bad">Rejected at step {r.rejection.stepOrder} ({r.rejection.stepName}): {r.rejection.reason} <Link to={`/requests/new/${r.formId}?from=${r.requestId}`}>Start a new request with these details</Link></p>
                )}
                {r.status === 'Cancelled' && <p className="req-note muted">Cancelled by an administrator.</p>}
                <SignOff steps={r.steps} toMe />
              </article>
            ))}
            {pages > 1 && (
              <div className="actions pager">
                <button disabled={page <= 1} onClick={() => go({ page: String(page - 1) })}>← Newer</button>
                <span className="muted small">Page {page} of {pages}</span>
                <button disabled={page >= pages} onClick={() => go({ page: String(page + 1) })}>Older →</button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------
interface MyRequestDetail {
  requestId: number; requestNumber: string; formId: number; formName: string; status: string; submittedAt: string; closedAt: string | null;
  progress: { currentStep: number | null; totalSteps: number; waitingOn: string | null; waitingSince: string | null; label: string };
  sentBack: { stepOrder: number; stepName: string; returnedBy: string; returnedAt: string; reason: string } | null;
  returns: SendBack[];
  rejection: { reason: string; stepOrder: number; stepName: string | null; rejectedBy: string | null; rejectedAt: string | null } | null;
  cancelReason: string | null; pdfAvailable: boolean; data: FieldValue[];
  steps: { stepOrder: number; name: string; status: string; approver: string; activatedAt: string | null; actedAt: string | null; comments?: string | null; responses?: FieldValue[] }[];
}

/**
 * Values for the form from an earlier submission's stored values. Fields that no longer exist or changed type are
 * skipped, and a drawn signature is never carried over: it has to be made again for what is being sent now.
 */
function valuesFrom(fields: FieldDef[], data: FieldValue[]): Values {
  const next: Values = {};
  for (const def of fields) {
    const old = data.find((d) => d.key === def.key && d.type === def.type);
    if (old?.value == null || def.type === 'sigpad') continue;
    if (def.type === 'checkbox') next[def.key] = old.value === 'true';
    else if (def.type === 'multiselect') { try { next[def.key] = JSON.parse(old.value) as string[]; } catch { /* skip */ } }
    else if (def.type === 'grid') {
      // only what was typed into columns that still exist; calculated cells are worked out again
      const cols = (def.props?.columns ?? []).filter((c) => c.type !== 'calc');
      try { next[def.key] = (JSON.parse(old.value) as GridValue).rows.map((r) => Object.fromEntries(cols.filter((c) => r[c.key] != null).map((c) => [c.key, r[c.key] as string]))); } catch { /* skip */ }
    }
    else next[def.key] = old.value;
  }
  return next;
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
      setValues(applyLookups(f.fields, valuesFrom(f.fields, prev.data), f.lookups));
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

/** Edit a request an approver sent back, then resubmit it: /requests/:requestId/edit */
export function ResubmitPage() {
  const { requestId } = useParams();
  const navigate = useNavigate();
  const [req, setReq] = useState<MyRequestDetail | null>(null);
  const [form, setForm] = useState<{ fields: FieldDef[]; lookups?: Lookups } | null>(null);
  const [values, setValues] = useState<Values>({});
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const [{ request }, loaded] = await Promise.all([
        api<{ request: MyRequestDetail }>(`/my/requests/${requestId}`),
        api<{ fields: FieldDef[]; lookups?: Lookups }>(`/my/requests/${requestId}/form`),
      ]);
      if (!live) return;
      const fields = withLookupOptions(loaded.fields, loaded.lookups);
      setReq(request);
      setForm({ fields, lookups: loaded.lookups });
      setValues(applyLookups(fields, { ...initialValues(fields), ...valuesFrom(fields, request.data) }, loaded.lookups));
    })().catch(() => live && setLoadError('This request could not be opened.'));
    return () => void (live = false);
  }, [requestId]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setErrors({});
    setFormError('');
    try {
      await api(`/my/requests/${requestId}/resubmit`, { method: 'POST', body: { values: toPayload(form.fields, values), note: note.trim() || undefined } });
      navigate(`/requests/${requestId}?resubmitted=1`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation_failed') {
        setErrors(err.fieldErrors);
        setFormError('Please fix the highlighted fields.');
      } else setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Nothing was resubmitted.');
      setBusy(false);
    }
  };

  if (loadError) return <div className="card"><p className="notice bad">{loadError}</p><Link to={'/'}>Back</Link></div>;
  if (!req || !form) return <p className="muted center">Loading…</p>;
  if (!req.sentBack) {
    return (
      <div className="card">
        <p className="notice">{req.requestNumber} is not waiting for changes from you, so there is nothing to edit.</p>
        <Link to={`/requests/${req.requestId}`}>View the request</Link>
      </div>
    );
  }
  const hasSignature = form.fields.some((f) => f.type === 'sigpad');
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <div className="page-head">
        <div>
          <p className="eyebrow">{req.formName} <span className="reqno">{req.requestNumber}</span></p>
          <h1>Make changes and resubmit</h1>
        </div>
        <StatusBadge status="Returned" />
      </div>
      <div className="notice back">
        <p style={{ marginTop: 0 }}><strong>{req.sentBack.returnedBy} asked for these changes</strong> on {fmtDateTime(req.sentBack.returnedAt)}:</p>
        <blockquote style={{ marginBottom: 0 }}>{req.sentBack.reason}</blockquote>
      </div>
      <section className="card">
        {formError && <p className="notice bad" role="alert">{formError}</p>}
        {hasSignature && <p className="notice">Signatures are not carried over: please sign again.</p>}
        <FieldGrid defs={form.fields}>
          {(f) => <FieldInput def={f} value={values[f.key]} error={errors[f.key]} disabled={busy} onChange={(v) => setValues((s) => applyLookups(form.fields, { ...s, [f.key]: v }, form.lookups))} />}
        </FieldGrid>
        <div className="field" style={{ marginTop: '1rem' }}>
          <label htmlFor="note">Note for {req.sentBack.returnedBy} (optional)</label>
          <textarea id="note" rows={2} maxLength={2000} value={note} disabled={busy} onChange={(e) => setNote(e.target.value)} placeholder="What did you change?" />
        </div>
        <div className="actions">
          <button className="primary" type="submit" disabled={busy}>{busy ? 'Resubmitting…' : `Resubmit to ${req.sentBack.returnedBy}`}</button>
          <Link to={`/requests/${req.requestId}`}>Cancel</Link>
        </div>
      </section>
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
          <p className="eyebrow"><Link to={'/'}>My submissions</Link> / {r.requestNumber}</p>
          <div className="title-row"><h1>{r.formName}</h1><span className="reqno">{r.requestNumber}</span></div>
          <p className="muted">Submitted {fmtDateTime(r.submittedAt)}{r.closedAt && `, closed ${fmtDateTime(r.closedAt)}`}</p>
        </div>
        <StatusBadge status={r.sentBack ? 'Returned' : r.status} />
      </div>
      <SignOff steps={r.steps} big toMe />

      {params.get('submitted') && r.status === 'InProgress' && <p className="notice ok" role="status">Submitted. We have emailed you a confirmation and notified the first approver.</p>}
      {params.get('resubmitted') && r.status === 'InProgress' && !r.sentBack && <p className="notice ok" role="status">Resubmitted. {r.progress.waitingOn} has been emailed and can decide now.</p>}
      {r.sentBack && (
        <div className="notice back">
          <p style={{ marginTop: 0 }}><strong>{r.sentBack.returnedBy} sent this back to you for changes</strong> on {fmtDateTime(r.sentBack.returnedAt)} (step {r.sentBack.stepOrder}, {r.sentBack.stepName}):</p>
          <blockquote>{r.sentBack.reason}</blockquote>
          <p>Steps already approved stay approved. When you resubmit, it goes straight back to {r.sentBack.returnedBy}.</p>
          <div className="actions" style={{ marginBottom: 0 }}><Link className="button primary" to={`/requests/${r.requestId}/edit`}>Make the changes</Link></div>
        </div>
      )}
      {r.status === 'InProgress' && !r.sentBack && <p className="notice"><strong>{r.progress.label}</strong>{r.progress.waitingSince && <> for {waitedFor(r.progress.waitingSince)}</>}. You will be emailed when a final decision is made.</p>}
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
          <li className="stepper-submitted">
            <span className="stepper-n">✓</span>
            <div>
              <div className="prev-head"><strong>Submitted</strong></div>
              <p className="muted small" style={{ margin: 0 }}>{fmtDateTime(r.submittedAt)}</p>
            </div>
          </li>
          {r.steps.map((s) => {
            const backs = r.returns.filter((x) => x.stepOrder === s.stepOrder);
            return (
              <li key={s.stepOrder} className={`stepper-${s.status.toLowerCase()}`}>
                <span className="stepper-n">{s.status === 'Approved' ? '✓' : s.status === 'Rejected' ? '✕' : s.status === 'Returned' ? '↩' : s.stepOrder}</span>
                <div>
                  <div className="prev-head"><strong>{s.name}</strong><StatusBadge status={s.status} /></div>
                  <p className="muted small" style={{ margin: 0 }}>
                    {s.status === 'Active' ? <>Waiting on <strong>{s.approver}</strong>{s.activatedAt && ` since ${fmtDateTime(s.activatedAt)} (${waitedFor(s.activatedAt)})`}</>
                      : s.status === 'Returned' ? `Sent back to you by ${r.sentBack?.returnedBy ?? s.approver} - waiting for your changes`
                      : s.actedAt ? `${s.approver}, ${fmtDateTime(s.actedAt)}` : s.approver}
                  </p>
                  {/* earlier rounds at this step: what was asked, and what you changed */}
                  {backs.filter((x) => x.resubmittedAt).map((x, i) => (
                    <details key={i} className="small" style={{ marginTop: '.4rem' }}>
                      <summary>Sent back by {x.returnedBy} on {fmtDateTime(x.returnedAt)}, resubmitted {fmtDateTime(x.resubmittedAt)}</summary>
                      <blockquote>{x.reason}</blockquote>
                      {x.resubmitNote && <p style={{ margin: '.25rem 0' }}>Your note: {x.resubmitNote}</p>}
                      <ChangeList changes={x.changes} />
                    </details>
                  ))}
                  {s.responses && s.responses.length > 0 && <div style={{ marginTop: '.5rem' }}><ValueList items={s.responses} /></div>}
                  {s.comments && <blockquote>{s.comments}</blockquote>}
                </div>
              </li>
            );
          })}
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
  const { user } = useAuth();
  const approver = !!user && (user.roles.includes('Approver') || user.roles.includes('Admin'));
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
    <div className="stack" style={{ maxWidth: 560 }}>
    {approver && <ApprovalEmailChoice />}
    <form className="card" onSubmit={submit}>
      <h1>Change password key</h1>
      {msg && <p className={`notice ${msg.ok ? 'ok' : 'bad'}`} role="status">{msg.text}</p>}
      <div className="field"><label htmlFor="cp">Current key</label><input id="cp" {...field} autoComplete="current-password" value={current} onChange={digits(setCurrent)} /></div>
      <div className="field"><label htmlFor="np">New 6-digit key</label><input id="np" {...field} autoComplete="new-password" value={next} onChange={digits(setNext)} /><p className="hint">Digits only. Obvious keys such as 123456 or 111111 are refused.</p></div>
      <div className="field"><label htmlFor="np2">Repeat the new key</label><input id="np2" {...field} autoComplete="new-password" value={confirm} onChange={digits(setConfirm)} /></div>
      <button className="primary" type="submit" disabled={current.length !== 6 || next.length !== 6 || confirm.length !== 6}>Change key</button>
      <p className="muted small">Forgotten your current key? Sign out and choose "Forgot your key?" on the sign-in page.</p>
    </form>
    </div>
  );
}

/** An email per request as it arrives, or one summary each weekday morning (server/src/workflow/digest.ts). */
function ApprovalEmailChoice() {
  const { data, error } = useLoad<Prefs>('/my/preferences');
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (error) return <div className="card"><p className="notice bad">{error}</p></div>;
  if (!data) return null;
  const p = prefs ?? data;
  const zone = myTimeZone();
  const save = async (next: { emailDigest: boolean; digestHour?: number }) => {
    setBusy(true);
    setMsg(null);
    try {
      // the hour is the person's own: send the zone of this browser with it
      const saved = await api<Prefs>('/my/preferences', { method: 'PUT', body: { ...next, timeZone: zone } });
      setPrefs(saved);
      setMsg({ ok: true, text: saved.emailDigest ? `Done. You get one summary each weekday at ${hourLabel(saved.digestHour)}, and no email per request.` : 'Done. You will be emailed about each request as it arrives.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : 'Something went wrong.' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>Approval emails</h2>
      {msg && <p className={`notice ${msg.ok ? 'ok' : 'bad'}`} role="status">{msg.text}</p>}
      <label className="check" style={{ marginBottom: '.5rem' }}>
        <input type="radio" name="digest" checked={!p.emailDigest} disabled={busy} onChange={() => void save({ emailDigest: false })} />
        <span><strong>Email me about each request as it arrives</strong></span>
      </label>
      <label className="check">
        <input type="radio" name="digest" checked={p.emailDigest} disabled={busy} onChange={() => void save({ emailDigest: true, digestHour: p.digestHour })} />
        <span><strong>Send me one summary a day instead</strong> - Monday to Friday, listing everything waiting for you, only when something is</span>
      </label>
      {p.emailDigest && (
        <div className="field" style={{ margin: '.75rem 0 0 1.6rem' }}>
          <label htmlFor="digest-hour">Send it at</label>
          <select id="digest-hour" value={p.digestHour} disabled={busy} onChange={(e) => void save({ emailDigest: true, digestHour: Number(e.target.value) })} style={{ maxWidth: '10rem' }}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
          <p className="hint">Your time{zone ? ` (${zone.replace(/_/g, ' ')})` : ''}. It arrives within a few minutes after.</p>
        </div>
      )}
      <p className="hint">Either way, everything waiting is always on your home page. With the summary you get no separate approval, resubmitted or reminder emails; an administrator's own reminder still reaches you straight away.</p>
    </section>
  );
}

interface Prefs { emailDigest: boolean; digestHour: number; timeZone: string | null }
const hourLabel = (h: number) => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
