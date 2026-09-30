// One customer: its address and status, its administrators, its settings, and support access.
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { SettingsForm, type TenantSettings } from '../../pages/admin/Settings';
import { gapi, type TenantAdmin, type TenantSummary } from '../api';
import { useGlobalAction, useGlobalLoad } from '../hooks';

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function Admins({ tenantId, admins, reload }: { tenantId: number; admins: TenantAdmin[]; reload(): void }) {
  const act = useGlobalAction();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [confirmReset, setConfirmReset] = useState<TenantAdmin | null>(null);

  const grant = () =>
    act.run(async () => {
      const res = await gapi<{ outcome: 'created' | 'granted' | 'reactivated' }>(`/tenants/${tenantId}/admins`, { method: 'POST', body: { email: email.trim(), displayName: name.trim() || undefined } });
      const who = email.trim();
      setEmail('');
      setName('');
      reload();
      return res.outcome === 'created' ? `Account created for ${who} as an administrator. They have been emailed how to sign in and will choose their own key.`
        : res.outcome === 'reactivated' ? `${who} was deactivated: reactivated and made an administrator.`
        : `${who} is now an administrator.`;
    });

  const revoke = (a: TenantAdmin) =>
    act.run(async () => {
      await gapi(`/tenants/${tenantId}/admins`, { method: 'POST', body: { email: a.email, remove: true } });
      reload();
      return `${a.email} is no longer an administrator.`;
    });

  const resetKey = (a: TenantAdmin) =>
    act.run(async () => {
      await gapi(`/tenants/${tenantId}/admins/${a.userId}/reset-key`, { method: 'POST' });
      setConfirmReset(null);
      reload();
      return `${a.email} will choose a new key at their next sign-in, after verifying their email.`;
    });

  return (
    <section className="card stack">
      <h2>Administrators</h2>
      <table className="sample-table">
        <thead><tr><th>Name</th><th>Email</th><th>Key</th><th /></tr></thead>
        <tbody>
          {admins.map((a) => (
            <tr key={a.userId}>
              <td>{a.displayName}</td>
              <td className="mono">{a.email}</td>
              <td>{a.hasKey ? 'Set' : <span className="muted">Not set yet</span>}</td>
              <td className="row-actions">
                <button className="link" disabled={act.busy} onClick={() => setConfirmReset(a)}>Reset key</button>
                <button className="link" disabled={act.busy} onClick={() => void revoke(a)}>Remove</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {confirmReset && (
        <p className="notice">
          Forget {confirmReset.email}'s key? They will set a new one at their next sign-in, with an emailed verification code.{' '}
          <button className="link" onClick={() => void resetKey(confirmReset)}>Yes, reset it</button>{' '}
          <button className="link" onClick={() => setConfirmReset(null)}>Cancel</button>
        </p>
      )}

      <h3 style={{ margin: 0 }}>Add an administrator</h3>
      <div className="field">
        <label htmlFor="grant">Email</label>
        <input id="grant" type="email" value={email} placeholder="person@customer.example" onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="grant-name">Full name</label>
        <input id="grant-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        <p className="hint">Anyone can be added. Someone who already has an account here just becomes an administrator (the name is not needed). Someone new gets an account - enter their name - and an email telling them how to sign in; they choose their own key. Any email address is accepted, even outside the organisation's allowed domains.</p>
      </div>
      {act.error && <p className="notice error" role="alert">{act.error}</p>}
      {act.ok && <p className="notice" role="status">{act.ok}</p>}
      <div className="actions">
        <button disabled={act.busy || !email.trim()} onClick={() => void grant()}>Add administrator</button>
      </div>
    </section>
  );
}

function Identity({ tenant, reload }: { tenant: TenantSummary; reload(): void }) {
  const act = useGlobalAction();
  const [name, setName] = useState(tenant.name);
  const [host, setHost] = useState(tenant.host ?? '');
  const [notifyEmail, setNotifyEmail] = useState(tenant.notifyEmail ?? '');
  const [confirmSuspend, setConfirmSuspend] = useState(false);

  const save = () =>
    act.run(async () => {
      await gapi(`/tenants/${tenant.tenantId}`, {
        method: 'PATCH',
        body: { name: name.trim(), host: host.trim() || null, notifyEmail: notifyEmail.trim() || null },
      });
      reload();
      return 'Saved.';
    });

  const setActive = (isActive: boolean) =>
    act.run(async () => {
      await gapi(`/tenants/${tenant.tenantId}`, { method: 'PATCH', body: { isActive } });
      setConfirmSuspend(false);
      reload();
      return isActive ? 'This customer is active again.' : 'This customer is suspended and everyone has been signed out.';
    });

  return (
    <section className="card stack">
      <h2>Address and status</h2>
      {act.error && <p className="notice error">{act.error}</p>}
      {act.ok && <p className="notice">{act.ok}</p>}
      <div className="field">
        <label htmlFor="cname">Organisation name</label>
        <input id="cname" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="chost">Host name</label>
        <input id="chost" value={host} placeholder={`${tenant.slug}.…`} onChange={(e) => setHost(e.target.value)} />
        <p className="hint">Currently reached at <a href={tenant.url} target="_blank" rel="noreferrer">{tenant.url}</a>. Changing this needs a matching DNS entry.</p>
      </div>
      <div className="field">
        <label htmlFor="cnotify">Notification address</label>
        <input id="cnotify" type="email" value={notifyEmail} onChange={(e) => setNotifyEmail(e.target.value)} />
        <p className="hint">Where alerts go when nobody more specific applies. Blank means every administrator.</p>
      </div>
      <div className="actions">
        <button className="primary" disabled={act.busy} onClick={() => void save()}>Save</button>
        {tenant.isActive ? (
          <button className="link" disabled={act.busy} onClick={() => setConfirmSuspend(true)}>Suspend this customer</button>
        ) : (
          <button className="link" disabled={act.busy} onClick={() => void setActive(true)}>Reactivate</button>
        )}
      </div>
      {confirmSuspend && (
        <p className="notice">
          Suspending stops all sign-in and signs out everyone who is currently using it. Their data is untouched.{' '}
          <button className="link" onClick={() => void setActive(false)}>Yes, suspend it</button>{' '}
          <button className="link" onClick={() => setConfirmSuspend(false)}>Cancel</button>
        </p>
      )}
    </section>
  );
}

/** Where this customer's closed-request PDFs and approvers' attachments are kept. */
function FileStorage({ tenant, reload }: { tenant: TenantSummary; reload(): void }) {
  const act = useGlobalAction();
  const [folder, setFolder] = useState(tenant.fileStorageRoot ?? '');
  const current = tenant.fileStorageRoot;

  const save = (value: string | null) =>
    act.run(async () => {
      await gapi(`/tenants/${tenant.tenantId}`, { method: 'PATCH', body: { fileStorageRoot: value } });
      reload();
      return value ? `New files for ${tenant.name} will be saved in ${value}.` : `New files for ${tenant.name} will be kept in the database.`;
    });

  return (
    <section className="card stack">
      <h2>File storage</h2>
      {act.error && <p className="notice error">{act.error}</p>}
      {act.ok && <p className="notice">{act.ok}</p>}
      <p className="muted" style={{ margin: 0 }}>
        Closed-request PDFs and approvers' attachments are kept {current ? <>in the folder <strong className="mono">{current}</strong></> : <>in the database</>}.
      </p>
      <div className="field">
        <label htmlFor="cfolder">Folder for this customer's files</label>
        <input id="cfolder" className="mono" value={folder} placeholder="D:\CustomerFiles\Acme  or  \\fileserver\approvals\Acme" onChange={(e) => setFolder(e.target.value)} />
        <p className="hint">
          Files are saved there only, in one sub-folder per day (the day each request was submitted, e.g. 2026-09-28), and the app refuses any file changed outside it. The account the app runs as needs Modify permission on the folder; it is checked when you save.
          Changing this affects new files only - files already saved stay where they are.
        </p>
      </div>
      <div className="actions">
        <button className="primary" disabled={act.busy || !folder.trim() || folder.trim() === current} onClick={() => void save(folder.trim())}>{act.busy ? 'Checking…' : 'Use this folder'}</button>
        {current && <button className="link" disabled={act.busy} onClick={() => { setFolder(''); void save(null); }}>Keep new files in the database instead</button>}
      </div>
    </section>
  );
}

const fmtDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '—');

function RemoveCustomer({ tenant }: { tenant: TenantSummary }) {
  const act = useGlobalAction();
  const navigate = useNavigate();
  const [confirmSlug, setConfirmSlug] = useState('');

  const remove = () =>
    act.run(async () => {
      const res = await gapi<{ tenant: TenantSummary }>(`/tenants/${tenant.tenantId}`, { method: 'DELETE', body: { confirmSlug: confirmSlug.trim() } });
      navigate('/', { state: { notice: `${tenant.name} has been removed. Its data will be deleted on ${fmtDay(res.tenant.purgeAfter)} unless you restore it.` } });
      return '';
    });

  return (
    <section className="card stack">
      <h2>Remove this customer</h2>
      {act.error && <p className="notice error">{act.error}</p>}
      {tenant.isActive ? (
        <p className="muted">Suspend this customer first. Removing is only possible once nobody can sign in.</p>
      ) : (
        <>
          <p className="notice error">
            Removing {tenant.name} keeps its data for 30 days, frozen, and you can restore it at any time during that period. After that its{' '}
            {tenant.counts.users} people, {tenant.counts.forms} forms, {tenant.counts.requests} requests, lookups, settings, audit history and
            stored files are deleted permanently.
          </p>
          <div className="field">
            <label htmlFor="confirmSlug">Type <span className="mono">{tenant.slug}</span> to confirm</label>
            <input id="confirmSlug" value={confirmSlug} autoComplete="off" onChange={(e) => setConfirmSlug(e.target.value)} />
          </div>
          <div className="actions">
            <button className="danger" disabled={act.busy || confirmSlug.trim() !== tenant.slug} onClick={() => void remove()}>
              Remove customer
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** Shown instead of everything else while a removed customer waits for deletion. */
function Removed({ tenant, reload }: { tenant: TenantSummary; reload(): void }) {
  const act = useGlobalAction();
  const restore = () =>
    act.run(async () => {
      await gapi(`/tenants/${tenant.tenantId}/restore`, { method: 'POST' });
      reload();
      return 'Restored. The customer is still suspended - reactivate it when they should be able to sign in again.';
    });

  return (
    <section className="card stack">
      <h2>Removed</h2>
      {act.error && <p className="notice error">{act.error}</p>}
      <p className="notice error">
        Removed on {fmtDay(tenant.removedAt)}. All of its data will be <strong>deleted permanently on {fmtDay(tenant.purgeAfter)}</strong>. Until then
        nothing can be changed, nobody can sign in, and its address stays reserved.
      </p>
      <div className="actions">
        <button className="primary" disabled={act.busy} onClick={() => void restore()}>Restore this customer</button>
      </div>
    </section>
  );
}

function SupportAccess({ tenant }: { tenant: TenantSummary }) {
  const act = useGlobalAction();
  const [link, setLink] = useState('');
  const [reason, setReason] = useState('');

  const start = () =>
    act.run(async () => {
      const res = await gapi<{ accessToken: string; expiresInMinutes: number; actingAs: { email: string }; url: string }>(
        `/tenants/${tenant.tenantId}/impersonate`,
        { method: 'POST', body: { reason: reason.trim() || undefined } },
      );
      setLink(`${res.url}/#support=${res.accessToken}`);
      return `Acting as ${res.actingAs.email} for ${res.expiresInMinutes} minutes.`;
    });

  return (
    <section className="card stack">
      <h2>Support access</h2>
      <p className="muted">
        Opens this customer's portal as one of its administrators, for 30 minutes. It is recorded in this customer's own audit log, and
        everything done during it is stamped with your name - the customer can see exactly what happened.
      </p>
      {act.error && <p className="notice error">{act.error}</p>}
      {act.ok && <p className="notice">{act.ok}</p>}
      <div className="field">
        <label htmlFor="reason">Why (recorded in the audit log)</label>
        <input id="reason" value={reason} placeholder="Ticket 1234" onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="actions">
        <button disabled={act.busy || !tenant.isActive} onClick={() => void start()}>Start support session</button>
        {link && <a className="primary" href={link} target="_blank" rel="noreferrer">Open the portal</a>}
      </div>
      {!tenant.isActive && <p className="hint">Suspended customers cannot be opened.</p>}
    </section>
  );
}

export function CustomerDetail() {
  const tenantId = Number(useParams().tenantId);
  const detail = useGlobalLoad<{ tenant: TenantSummary; admins: TenantAdmin[] }>(`/tenants/${tenantId}`);
  const settings = useGlobalLoad<{ settings: TenantSettings }>(`/tenants/${tenantId}/settings`);

  if (detail.error) return <p className="notice error">{detail.error}</p>;
  if (!detail.data) return <p className="muted">Loading…</p>;
  const { tenant, admins } = detail.data;

  return (
    <>
      <div className="page-head">
        <div>
          <p className="eyebrow"><Link to="/">Customers</Link></p>
          <h1>{tenant.name}</h1>
          <p className="muted">
            Created {fmt(tenant.createdAt)} · {tenant.counts.users} people · {tenant.counts.requests} requests
            {tenant.removedAt ? (
              <> · <span className="badge badge-rejected">Removed · deleted on {fmtDay(tenant.purgeAfter)}</span></>
            ) : (
              !tenant.isActive && <> · <span className="badge badge-rejected">Suspended</span></>
            )}
          </p>
        </div>
      </div>

      {tenant.removedAt ? (
        <Removed tenant={tenant} reload={detail.reload} />
      ) : (
        <>
          <Identity tenant={tenant} reload={detail.reload} />
          <FileStorage tenant={tenant} reload={detail.reload} />
          <Admins tenantId={tenantId} admins={admins} reload={detail.reload} />
          <SupportAccess tenant={tenant} />
          <RemoveCustomer tenant={tenant} />
        </>
      )}

      {settings.data && !tenant.removedAt && (
        <SettingsForm
          title="Settings"
          settings={settings.data.settings}
          save={async (patch) => {
            await gapi(`/tenants/${tenantId}/settings`, { method: 'PATCH', body: patch });
            settings.reload();
          }}
        />
      )}
    </>
  );
}
