import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, download, uploadFile } from '../../api';
import { useAuth } from '../../auth';
import { fmtDateTime } from '../../fields';
import { useAction, useLoad, type UserRow } from '../../hooks';

const ROLES = ['Admin', 'Approver', 'Submitter'] as const;

interface ImportRow { row: number; email: string; displayName: string; roles: string[]; status: 'add' | 'added' | 'exists' | 'error'; message?: string }
interface ImportResult { dryRun: boolean; warnings: string[]; summary: { rows: number; add: number; added: number; exists: number; errors: number }; rows: ImportRow[] }

const STATUS_LABEL: Record<ImportRow['status'], string> = { add: 'Will be added', added: 'Added', exists: 'Skipped', error: 'Problem' };

/** Add one person, or many from an Excel sheet. Nobody gets a key from the admin: each person creates their own. */
function AddPeople({ onAdded }: { onAdded: () => void }) {
  const act = useAction();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roles, setRoles] = useState<string[]>(['Submitter']);
  const [sendEmail, setSendEmail] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const addOne = () =>
    act.run(async () => {
      await api('/admin/users', { method: 'POST', body: { email: email.trim(), displayName: name.trim(), roles, sendEmail } });
      const who = email.trim();
      setEmail(''); setName(''); setRoles(['Submitter']);
      onAdded();
      return `${who} was added.${sendEmail ? ' They have been emailed how to sign in.' : ''}`;
    });

  const importPath = (dryRun: boolean) => `/admin/users/import?dryRun=${dryRun ? 1 : 0}&sendEmail=${sendEmail ? 1 : 0}`;
  const check = (f: File) =>
    act.run(async () => {
      setFile(f);
      setPreview(await uploadFile<ImportResult>(importPath(true), f));
    });
  const confirm = () =>
    act.run(async () => {
      const r = await uploadFile<ImportResult>(importPath(false), file!);
      setPreview(r);
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      onAdded();
      return `${r.summary.added} ${r.summary.added === 1 ? 'person was' : 'people were'} added.`;
    });

  return (
    <section className="card stack">
      <h2>Add people</h2>
      {act.error && <p className="notice bad" role="alert">{act.error}</p>}
      {act.ok && <p className="notice ok" role="status">{act.ok}</p>}
      <label className="check"><input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} /><span>Email each new person how to sign in</span></label>

      <fieldset className="b-auto">
        <legend>One person</legend>
        <div className="grid2">
          <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        </div>
        <div style={{ margin: '.5rem 0' }}>
          {ROLES.map((role) => (
            <label key={role} className="check inline"><input type="checkbox" checked={roles.includes(role)} onChange={() => setRoles((r) => (r.includes(role) ? r.filter((x) => x !== role) : [...r, role]))} /><span>{role}</span></label>
          ))}
        </div>
        <button className="primary" disabled={act.busy || !email.trim() || name.trim().length < 2 || roles.length === 0} onClick={() => void addOne()}>Add person</button>
      </fieldset>

      <fieldset className="b-auto">
        <legend>Many people from Excel</legend>
        <p className="hint" style={{ marginTop: 0 }}>A sheet with the headings <strong>Email</strong>, <strong>Name</strong> and <strong>Roles</strong> (Submitter, Approver or Admin; several separated by commas; empty means Submitter). People already in the list are skipped.</p>
        <div className="actions">
          <button type="button" onClick={() => void act.run(() => download('/admin/users/import-template', 'users-import-template.xlsx'))}>Download template</button>
          <input ref={fileInput} type="file" accept=".xlsx" aria-label="Excel file of people to add" disabled={act.busy} onChange={(e) => { const f = e.target.files?.[0]; setPreview(null); if (f) void check(f); }} />
        </div>
        {preview && (
          <div className="stack" style={{ marginTop: '.75rem' }}>
            {preview.warnings.map((w) => <p key={w} className="notice">{w}</p>)}
            <p>
              {preview.dryRun
                ? <><strong>{preview.summary.add}</strong> to add · {preview.summary.exists} already users (skipped) · {preview.summary.errors} with problems (skipped)</>
                : <><strong>{preview.summary.added}</strong> added · {preview.summary.exists} skipped · {preview.summary.errors} with problems</>}
            </p>
            <div style={{ maxHeight: 360, overflow: 'auto' }}>
              <table>
                <thead><tr><th>Row</th><th>Email</th><th>Name</th><th>Roles</th><th>Result</th></tr></thead>
                <tbody>{preview.rows.map((r) => (
                  <tr key={r.row} className={r.status === 'error' ? 'inactive' : ''}>
                    <td>{r.row}</td><td>{r.email}</td><td>{r.displayName}</td><td>{r.roles.join(', ')}</td>
                    <td>{r.status === 'error' ? <span className="field-error">{r.message}</span> : <>{STATUS_LABEL[r.status]}{r.message && r.status !== 'exists' ? ` - ${r.message}` : ''}</>}</td>
                  </tr>))}
                </tbody>
              </table>
            </div>
            {preview.dryRun && (
              <div className="actions">
                <button className="primary" disabled={act.busy || preview.summary.add === 0} onClick={() => void confirm()}>
                  {act.busy ? 'Adding…' : `Add ${preview.summary.add} ${preview.summary.add === 1 ? 'person' : 'people'}`}
                </button>
                <button onClick={() => { setPreview(null); setFile(null); if (fileInput.current) fileInput.current.value = ''; }}>Cancel</button>
              </div>
            )}
          </div>
        )}
      </fieldset>
    </section>
  );
}

export function AdminUsers() {
  const { user: me } = useAuth();
  const { data, error, reload } = useLoad<{ users: UserRow[] }>('/admin/users');
  const act = useAction();
  const [resetting, setResetting] = useState<UserRow | null>(null);

  const patch = (u: UserRow, body: Record<string, unknown>, done: string) =>
    act.run(async () => {
      const r = await api<{ pendingApprovals: number }>(`/admin/users/${u.userId}`, { method: 'PATCH', body });
      reload();
      return body.isActive === false && r.pendingApprovals > 0 ? `${u.displayName} deactivated. They still have ${r.pendingApprovals} approval step(s) assigned - reassign those from the Requests page (filter by approver).` : done;
    });
  const resetKey = (u: UserRow) =>
    act.run(async () => {
      await api(`/admin/users/${u.userId}/reset-key`, { method: 'POST' });
      setResetting(null);
      reload();
      return `${u.displayName}'s password key has been reset and they have been signed out. Tell them to sign in with their email: they will create a new key.`;
    });
  const toggle = (roles: string[], role: string) => (roles.includes(role) ? roles.filter((r) => r !== role) : [...roles, role]);

  return (
    <div className="stack">
      <h1>Users</h1>
      {act.error && <p className="notice bad" role="alert">{act.error}</p>}
      {act.ok && <p className="notice ok" role="status">{act.ok}</p>}
      <section className="card">
        {error ? <p className="notice bad">{error}</p> : !data ? <p className="muted">Loading…</p> : (
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Status</th><th title="Each person chooses this under their own name">Approval emails</th><th>Joined</th><th /></tr></thead>
            <tbody>{data.users.map((u) => (
              <tr key={u.userId} className={u.isActive ? '' : 'inactive'}>
                <td>{u.displayName}</td><td>{u.email}</td>
                <td>{ROLES.map((role) => (
                  <label key={role} className="check inline"><input type="checkbox" checked={u.roles.includes(role)} disabled={act.busy || (u.userId === me!.userId && role === 'Admin') || (u.roles.length === 1 && u.roles[0] === role)}
                    onChange={() => void patch(u, { roles: toggle(u.roles, role) }, 'Roles updated.')} /><span>{role}</span></label>))}
                </td>
                <td>{!u.isActive ? 'Inactive' : !u.hasKey ? <span className="badge badge-active">No key yet</span> : u.locked ? <span className="badge badge-rejected">Locked</span> : 'Active'}</td>
                <td className="small">{u.emailDigest ? 'Daily summary' : 'Each request'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{new Date(u.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</td>
                <td className="row-actions">
                  {u.userId !== me!.userId && <button className="link" disabled={act.busy} onClick={() => void patch(u, { isActive: !u.isActive }, u.isActive ? 'User deactivated.' : 'User reactivated.')}>{u.isActive ? 'Deactivate' : 'Reactivate'}</button>}
                  {u.isActive && u.hasKey && u.userId !== me!.userId && <button className="link" disabled={act.busy} onClick={() => setResetting(u)}>Reset password key</button>}
                </td>
              </tr>))}
            </tbody>
          </table>
        )}
      </section>
      <AddPeople onAdded={reload} />
      {resetting && (
        <section className="card reject-box">
          <h2>Reset {resetting.displayName}'s password key?</h2>
          <p>Only do this when they have asked you to, and you are sure it is really them. They will be signed out everywhere, their old key stops working, and the next time they sign in with <strong>{resetting.email}</strong> they will verify their email and create a new 6-digit key. Their roles and history are kept.</p>
          <div className="actions">
            <button className="danger" disabled={act.busy} onClick={() => void resetKey(resetting)}>Reset key</button>
            <button onClick={() => setResetting(null)}>Cancel</button>
          </div>
        </section>
      )}
      <section className="card">
        <h2>How people get an account</h2>
        <p className="muted" style={{ margin: 0 }}>Add people above - one at a time or from an Excel sheet - with their roles; they show <strong>No key yet</strong> until they first sign in. Anyone can also just sign in with their work email; they appear here as a <strong>Submitter</strong>. Either way, each person creates their own 6-digit password key the first time, after confirming their email - you never set or see anyone's key. Tick <strong>Approver</strong> for people who should approve requests - they must have signed in once before you can choose them in an approval chain. People who forget their key can reset it themselves from the sign-in page (a code is emailed to them). <strong>Reset password key</strong> is your fallback, for example when someone cannot use that route or you want to force a new key.</p>
      </section>
    </div>
  );
}

interface Entry { auditId: number; occurredAt: string; action: string; requestId: number | null; requestNumber: string | null; fromState: string | null; toState: string | null; user: string; ip: string | null; detail: unknown }

export function AdminAudit() {
  const [params, setParams] = useSearchParams();
  const users = useLoad<{ users: UserRow[] }>('/admin/users').data?.users ?? [];
  const query = new URLSearchParams([...params].filter(([, v]) => v));
  const { data, error } = useLoad<{ total: number; page: number; pageSize: number; entries: Entry[] }>(`/admin/audit?${query}`);
  const act = useAction();
  const [action, setAction] = useState(params.get('action') ?? '');
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };
  const page = Number(params.get('page') ?? 1);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const exportQuery = new URLSearchParams(query);
  exportQuery.delete('page');

  return (
    <div className="stack">
      <h1>Audit log</h1>
      <form className="card filters" onSubmit={(e) => { e.preventDefault(); set('action', action.trim()); }}>
        <label>Event contains<input value={action} onChange={(e) => setAction(e.target.value)} placeholder="e.g. step. or auth.login" /></label>
        <label>User<select value={params.get('userId') ?? ''} onChange={(e) => set('userId', e.target.value)}><option value="">Anyone</option>{users.map((u) => <option key={u.userId} value={u.userId}>{u.displayName}</option>)}</select></label>
        <label>From<input type="date" value={params.get('from') ?? ''} onChange={(e) => set('from', e.target.value)} /></label>
        <label>To<input type="date" value={params.get('to') ?? ''} onChange={(e) => set('to', e.target.value)} /></label>
        <div className="actions">
          <button className="primary" type="submit">Filter</button>
          <button type="button" disabled={act.busy} onClick={() => void act.run(() => download(`/admin/audit/export.csv?${exportQuery}`, 'audit-log.csv'))}>Export CSV</button>
        </div>
        {act.error && <p className="field-error">{act.error}</p>}
      </form>
      <section className="card">
        {error ? <p className="notice bad">{error}</p> : !data ? <p className="muted">Loading…</p> : data.entries.length === 0 ? <p className="muted">No entries match.</p> : (
          <>
            <table>
              <thead><tr><th>Time</th><th>Event</th><th>Change</th><th>Request</th><th>User</th><th>IP</th></tr></thead>
              <tbody>{data.entries.map((a) => (
                <tr key={a.auditId} title={a.detail ? JSON.stringify(a.detail) : undefined}>
                  <td>{fmtDateTime(a.occurredAt)}</td><td><code>{a.action}</code></td>
                  <td>{a.toState ? `${a.fromState ?? '—'} → ${a.toState}` : ''}</td>
                  <td>{a.requestId ? <Link to={`/admin/requests/${a.requestId}`}>{a.requestNumber}</Link> : ''}</td>
                  <td>{a.user}</td><td>{a.ip ?? '—'}</td>
                </tr>))}
              </tbody>
            </table>
            <div className="actions pager">
              <button disabled={page <= 1} onClick={() => set('page', String(page - 1))}>← Newer</button>
              <span className="muted small">Page {page} of {pages} · {data.total} entries</span>
              <button disabled={page >= pages} onClick={() => set('page', String(page + 1))}>Older →</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
