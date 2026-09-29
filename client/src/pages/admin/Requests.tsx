import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, download } from '../../api';
import { AttachmentList, type Attachment } from '../../attachments';
import { StatusBadge, ValueList, fmtDateTime, type FieldValue } from '../../fields';
import { useAction, useLoad, type FormRow, type UserRow } from '../../hooks';
import { ChangeList, type SendBack } from '../../sendback';
import { SignatureImage } from '../../sigpad';

/** What each archive state means, for the request page. */
const ARCHIVE_LABEL: Record<string, string> = {
  PdfPending: 'PDF being prepared',
  Stored: 'Stored in the database',
};

interface Row { requestId: number; requestNumber: string; formName: string; status: string; archiveStatus: string; currentStep: number | null; totalSteps: number; submitterName: string; waitingOn: string | null; submittedAt: string; overdue: boolean }
const FILTERS = ['formId', 'status', 'submitter', 'approver', 'from', 'to', 'q'] as const;

export function AdminRequests() {
  const [params, setParams] = useSearchParams();
  const forms = useLoad<{ forms: FormRow[] }>('/admin/forms').data?.forms ?? [];
  const users = useLoad<{ users: UserRow[] }>('/admin/users').data?.users ?? [];
  const query = new URLSearchParams([...params].filter(([, v]) => v));
  const { data, error } = useLoad<{ total: number; page: number; pageSize: number; requests: Row[] }>(`/admin/requests?${query}`);
  const [q, setQ] = useState(params.get('q') ?? '');

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };
  const page = Number(params.get('page') ?? 1);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="stack">
      <h1>Requests</h1>
      <form className="card filters" onSubmit={(e) => { e.preventDefault(); set('q', q.trim()); }}>
        <label>Search<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, submitter or content" /></label>
        <label>Form<select value={params.get('formId') ?? ''} onChange={(e) => set('formId', e.target.value)}><option value="">All</option>{forms.map((f) => <option key={f.formId} value={f.formId}>{f.name}</option>)}</select></label>
        <label>Status<select value={params.get('status') ?? ''} onChange={(e) => set('status', e.target.value)}>
          <option value="">All</option><option value="InProgress">In progress</option><option>Approved</option><option>Rejected</option><option>Cancelled</option><option>Overdue</option>
        </select></label>
        <label>Submitter<select value={params.get('submitter') ?? ''} onChange={(e) => set('submitter', e.target.value)}><option value="">Anyone</option>{users.filter((u) => u.roles.includes('Submitter')).map((u) => <option key={u.userId} value={u.userId}>{u.displayName}</option>)}</select></label>
        <label>Approver<select value={params.get('approver') ?? ''} onChange={(e) => set('approver', e.target.value)}><option value="">Anyone</option>{users.filter((u) => u.roles.includes('Approver') || u.roles.includes('Admin')).map((u) => <option key={u.userId} value={u.userId}>{u.displayName}</option>)}</select></label>
        <label>From<input type="date" value={params.get('from') ?? ''} onChange={(e) => set('from', e.target.value)} /></label>
        <label>To<input type="date" value={params.get('to') ?? ''} onChange={(e) => set('to', e.target.value)} /></label>
        <div className="actions">
          <button className="primary" type="submit">Search</button>
          {FILTERS.some((k) => params.get(k)) && <button type="button" onClick={() => { setQ(''); setParams({}, { replace: true }); }}>Clear</button>}
        </div>
      </form>

      <section className="card">
        {error ? <p className="notice bad">{error}</p> : !data ? <p className="muted">Loading…</p> : data.requests.length === 0 ? <p className="muted">No requests match.</p> : (
          <>
            <table>
              <thead><tr><th>Request</th><th>Form</th><th>Submitter</th><th>Submitted</th><th>Status</th><th>Progress</th></tr></thead>
              <tbody>
                {data.requests.map((r) => (
                  <tr key={r.requestId}>
                    <td><Link to={`/admin/requests/${r.requestId}`}>{r.requestNumber}</Link></td>
                    <td>{r.formName}</td><td>{r.submitterName}</td><td>{fmtDateTime(r.submittedAt)}</td>
                    <td><StatusBadge status={r.status} /> {r.overdue && <span className="badge badge-rejected">Overdue</span>}</td>
                    <td>{r.currentStep ? `Step ${r.currentStep} of ${r.totalSteps} · ${r.waitingOn}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="actions pager">
              <button disabled={page <= 1} onClick={() => set('page', String(page - 1))}>← Previous</button>
              <span className="muted small">Page {page} of {pages} · {data.total} request(s)</span>
              <button disabled={page >= pages} onClick={() => set('page', String(page + 1))}>Next →</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

interface Step { requestStepId: number; stepOrder: number; name: string; status: string; assignedUserId: number; assignedTo: string; delegateUserId: number | null; activatedAt: string | null; dueAt: string | null; actedAt: string | null; actedBy: string | null; actedIp: string | null; comments: string | null; signature: string | null; responses: FieldValue[]; attachments: Attachment[] }
interface Detail {
  request: { requestId: number; requestNumber: string; formName: string; status: string; totalSteps: number; submitterName: string; submittedAt: string; closedAt: string | null; rejectionReason: string | null; cancelReason: string | null; data: FieldValue[]; steps: Step[]; returns: SendBack[] };
  archive: { status: string; pdfAvailable: boolean; pdfBytes: number | null; pdfInFolder?: boolean };
  audit: { auditId: number; occurredAt: string; action: string; fromState: string | null; toState: string | null; ip: string | null; user: string }[];
  notifications: { notificationId: number; type: string; to: string; subject: string; status: string; attempts: number; createdAt: string; sentAt: string | null; lastError: string | null }[];
}

export function AdminRequestDetail() {
  const { requestId } = useParams();
  const { data, error, reload } = useLoad<Detail>(`/admin/requests/${requestId}`);
  const users = useLoad<{ users: UserRow[] }>('/admin/users').data?.users ?? [];
  const act = useAction();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [reassign, setReassign] = useState<{ stepId: number; userId: string; asDelegate: boolean } | null>(null);

  if (error) return <p className="notice bad">{error}</p>;
  if (!data) return <p className="muted center">Loading…</p>;
  const { request: r, archive } = data;
  const open = r.status === 'InProgress';
  const approvers = users.filter((u) => u.isActive && (u.roles.includes('Approver') || u.roles.includes('Admin')));
  const post = (path: string, body: unknown, done: string) => act.run(async () => { await api(`/admin/requests/${requestId}${path}`, { method: 'POST', body }); reload(); return done; });
  const userName = (id: number | null) => users.find((u) => u.userId === id)?.displayName;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="eyebrow">{r.formName}</p>
          <h1>{r.requestNumber}</h1>
          <p className="muted">Submitted by {r.submitterName} on {fmtDateTime(r.submittedAt)}{r.closedAt && ` · closed ${fmtDateTime(r.closedAt)}`}</p>
        </div>
        <StatusBadge status={r.status} />
      </div>
      {act.error && <p className="notice bad" role="alert">{act.error}</p>}
      {act.ok && <p className="notice ok" role="status">{act.ok}</p>}
      {r.rejectionReason && <p className="notice bad"><strong>Rejection reason:</strong> {r.rejectionReason}</p>}
      {r.cancelReason && <p className="notice bad"><strong>Cancelled:</strong> {r.cancelReason}</p>}

      <section className="card">
        <h2>Actions</h2>
        <div className="actions">
          <button disabled={!open || act.busy} onClick={() => void post('/remind', undefined, 'Reminder sent with a fresh link.')}>Send reminder</button>
          <button className="danger-outline" disabled={!open || act.busy} onClick={() => setCancelling(true)}>Cancel request…</button>
          <button disabled={!archive.pdfAvailable} onClick={() => void act.run(() => download(`/admin/requests/${requestId}/pdf`, `${r.requestNumber}.pdf`))}>Download PDF</button>
        </div>
        {cancelling && (
          <div className="reject-box">
            <div className="field"><label htmlFor="cr">Reason for cancelling<em className="req"> *</em></label><textarea id="cr" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
              <p className="hint">Cancelling is final. The submitter is notified and the approval link stops working.</p></div>
            <div className="actions">
              <button className="danger" disabled={!reason.trim() || act.busy} onClick={() => void post('/cancel', { reason: reason.trim() }, 'Request cancelled.').then((ok) => ok && setCancelling(false))}>Confirm cancel</button>
              <button onClick={() => setCancelling(false)}>Back</button>
            </div>
          </div>
        )}
        {archive.status !== 'None' && (
          <dl className="values" style={{ marginTop: '1rem' }}>
            <div><dt>Archive status</dt><dd>{archive.pdfInFolder ? 'Stored in your file folder' : ARCHIVE_LABEL[archive.status] ?? archive.status}</dd></div>
            {archive.pdfBytes !== null && <div><dt>Stored PDF</dt><dd>{archive.pdfInFolder ? 'In your organisation\'s file folder' : 'In the database'} · {Math.max(1, Math.round(archive.pdfBytes / 1024))} KB</dd></div>}
          </dl>
        )}
      </section>

      <section className="card">
        <h2>Timeline</h2>
        <ol className="tracker">
          <li className="tracker-approved"><strong>Submitted</strong><p className="muted small">{r.submitterName} · {fmtDateTime(r.submittedAt)}</p><ValueList items={r.data} /></li>
          {r.steps.map((s) => (
            <li key={s.requestStepId} className={`tracker-${s.status.toLowerCase()}`}>
              <div className="prev-head"><strong>Step {s.stepOrder}: {s.name}</strong><StatusBadge status={s.status} /></div>
              <p className="muted small">
                {s.actedBy ? `${s.actedBy} · ${fmtDateTime(s.actedAt)}${s.actedIp ? ` · ${s.actedIp}` : ''}${s.actedBy !== s.assignedTo ? ` (assigned to ${s.assignedTo})` : ''}` : `Assigned to ${s.assignedTo}`}
                {!s.actedBy && s.delegateUserId && ` · delegate: ${userName(s.delegateUserId) ?? s.delegateUserId}`}
                {s.status === 'Active' && s.activatedAt && ` · waiting since ${fmtDateTime(s.activatedAt)}`}
                {s.status === 'Active' && s.dueAt && ` · due ${fmtDateTime(s.dueAt)}`}
              </p>
              {r.returns.filter((x) => x.stepOrder === s.stepOrder).map((x, i) => (
                <div key={i} className="notice back" style={{ margin: '.5rem 0' }}>
                  <p style={{ margin: 0 }}><strong>Sent back</strong> by {x.returnedBy} · {fmtDateTime(x.returnedAt)}: {x.reason}</p>
                  {x.resubmittedAt ? <><p style={{ margin: '.35rem 0 0' }}>Resubmitted by {r.submitterName} · {fmtDateTime(x.resubmittedAt)}{x.resubmitNote && `: ${x.resubmitNote}`}</p><ChangeList changes={x.changes} /></> : <p style={{ margin: '.35rem 0 0' }}>Waiting for {r.submitterName} to make changes.</p>}
                </div>
              ))}
              {s.responses.length > 0 && <ValueList items={s.responses} />}
              {s.comments && <blockquote>{s.comments}</blockquote>}
              {s.signature && <SignatureImage value={s.signature} label={`Signature of ${s.actedBy}`} />}
              <AttachmentList items={s.attachments ?? []} pathOf={(a) => `/admin/requests/${r.requestId}/attachments/${a.attachmentId}`} />
              {open && (s.status === 'Active' || s.status === 'Waiting' || s.status === 'Returned') && (
                reassign?.stepId === s.requestStepId ? (
                  <div className="actions">
                    <select value={reassign.userId} onChange={(e) => setReassign({ ...reassign, userId: e.target.value })} aria-label="New approver">
                      <option value="">Choose approver…</option>
                      {approvers.filter((u) => u.userId !== s.assignedUserId).map((u) => <option key={u.userId} value={u.userId}>{u.displayName}</option>)}
                    </select>
                    <label className="check"><input type="checkbox" checked={reassign.asDelegate} onChange={(e) => setReassign({ ...reassign, asDelegate: e.target.checked })} /><span>As delegate (keep {s.assignedTo} too)</span></label>
                    <button className="primary" disabled={!reassign.userId || act.busy}
                      onClick={() => void post('/reassign', { requestStepId: s.requestStepId, newUserId: Number(reassign.userId), asDelegate: reassign.asDelegate }, 'Step reassigned.').then((ok) => ok && setReassign(null))}>Save</button>
                    <button onClick={() => setReassign(null)}>Cancel</button>
                  </div>
                ) : <button className="link" onClick={() => setReassign({ stepId: s.requestStepId, userId: '', asDelegate: false })}>Reassign…</button>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="card">
        <h2>Emails</h2>
        <table>
          <thead><tr><th>Type</th><th>To</th><th>Status</th><th>Queued</th><th /></tr></thead>
          <tbody>{data.notifications.map((n) => (
            <tr key={n.notificationId}>
              <td>{n.type}</td><td>{n.to}</td>
              <td>{n.status}{n.lastError && <div className="field-error">{n.lastError}</div>}</td>
              <td>{fmtDateTime(n.createdAt)}</td>
              <td>{n.status === 'Failed' && <button className="link" onClick={() => void act.run(async () => { await api(`/admin/notifications/${n.notificationId}/resend`, { method: 'POST' }); reload(); return 'Email re-queued.'; })}>Resend</button>}</td>
            </tr>))}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Audit trail</h2>
        <table>
          <thead><tr><th>Time</th><th>Event</th><th>Change</th><th>User</th><th>IP</th></tr></thead>
          <tbody>{data.audit.map((a) => (
            <tr key={a.auditId}><td>{fmtDateTime(a.occurredAt)}</td><td><code>{a.action}</code></td><td>{a.toState ? `${a.fromState ?? '—'} → ${a.toState}` : ''}</td><td>{a.user}</td><td>{a.ip ?? '—'}</td></tr>))}
          </tbody>
        </table>
      </section>
      <p><Link to={`/admin/requests`}>← All requests</Link></p>
    </div>
  );
}
