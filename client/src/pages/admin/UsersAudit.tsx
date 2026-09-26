import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, download } from '../../api';
import { useAuth } from '../../auth';
import { fmtDateTime } from '../../fields';
import { useAction, useLoad, type UserRow } from '../../hooks';

const ROLES = ['Admin', 'Approver', 'Submitter'] as const;

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
            <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Status</th><th>Joined</th><th /></tr></thead>
            <tbody>{data.users.map((u) => (
              <tr key={u.userId} className={u.isActive ? '' : 'inactive'}>
                <td>{u.displayName}</td><td>{u.email}</td>
                <td>{ROLES.map((role) => (
                  <label key={role} className="check inline"><input type="checkbox" checked={u.roles.includes(role)} disabled={act.busy || (u.userId === me!.userId && role === 'Admin') || (u.roles.length === 1 && u.roles[0] === role)}
                    onChange={() => void patch(u, { roles: toggle(u.roles, role) }, 'Roles updated.')} /><span>{role}</span></label>))}
                </td>
                <td>{!u.isActive ? 'Inactive' : !u.hasKey ? <span className="badge badge-active">No key yet</span> : u.locked ? <span className="badge badge-rejected">Locked</span> : 'Active'}</td>
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
        <p className="muted" style={{ margin: 0 }}>You do not create users. Anyone signs in with their work email and creates their own 6-digit password key the first time; they appear here as a <strong>Submitter</strong>. Tick <strong>Approver</strong> for people who should approve requests - they must have signed in once before you can choose them in an approval chain. People who forget their key can reset it themselves from the sign-in page (a code is emailed to them). <strong>Reset password key</strong> is your fallback, for example when someone cannot use that route or you want to force a new key.</p>
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
