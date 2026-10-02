// The customer list: every organisation on this installation, plus the form that creates one.
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { gapi, type TenantSummary } from '../api';
import { useGlobalAction, useGlobalLoad } from '../hooks';

interface Stats {
  totals: { tenants: number; activeTenants: number; users: number; requests: number; openRequests: number; failedEmails: number; queuedEmails: number };
  recentActivity: { at: string; action: string; tenantName: string | null; by: string | null }[];
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/** Turns "Acme Corp" into "acme-corp", which is what the address will be. */
const slugify = (name: string) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);

function NewCustomer({ onCreated }: { onCreated(): void }) {
  const act = useGlobalAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [host, setHost] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [adminDisplayName, setAdminDisplayName] = useState('');
  const [fileStorageRoot, setFileStorageRoot] = useState('');
  const [created, setCreated] = useState<{ tenant: TenantSummary; adminEmail: string; key: string | null } | null>(null);

  const reset = () => {
    setName(''); setSlug(''); setSlugTouched(false); setHost(''); setAdminEmail(''); setAdminDisplayName(''); setFileStorageRoot('');
    act.clear();
  };

  const submit = () =>
    act.run(async () => {
      const body = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        host: host.trim() || null,
        adminEmail: adminEmail.trim(),
        adminDisplayName: adminDisplayName.trim(),
        fileStorageRoot: fileStorageRoot.trim() || null,
      };
      const res = await gapi<{ tenant: TenantSummary; admin: { email: string }; generatedAdminKey: string | null }>('/tenants', { method: 'POST', body });
      setCreated({ tenant: res.tenant, adminEmail: res.admin.email, key: res.generatedAdminKey });
      setOpen(false);
      reset();
      onCreated();
    });

  if (created) {
    return (
      <section className="card stack">
        <h2>{created.tenant.name} is ready</h2>
        <p>
          Its address is <a href={created.tenant.url} target="_blank" rel="noreferrer">{created.tenant.url}</a>, and{' '}
          <strong>{created.adminEmail}</strong> is its administrator.
        </p>
        {created.key && (
          <p className="notice">
            First sign-in key: <strong className="mono">{created.key}</strong>
            <br />
            This is shown once and is not stored anywhere in readable form. Pass it to the administrator, who can change it after signing in.
          </p>
        )}
        <div className="actions">
          <Link className="primary" to={`/customers/${created.tenant.tenantId}`}>Open this customer</Link>
          <button className="link" onClick={() => setCreated(null)}>Done</button>
        </div>
      </section>
    );
  }

  if (!open) {
    return (
      <div className="actions">
        <button className="primary" onClick={() => setOpen(true)}>New customer</button>
      </div>
    );
  }

  return (
    <section className="card stack">
      <h2>New customer</h2>
      {act.error && <p className="notice error">{act.error}</p>}
      <div className="field">
        <label htmlFor="name">Organisation name</label>
        <input id="name" autoFocus value={name} onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }} />
      </div>
      <div className="field">
        <label htmlFor="slug">Address</label>
        <input id="slug" value={slug} onChange={(e) => { setSlugTouched(true); setSlug(e.target.value); }} />
        <p className="hint">Lowercase letters, digits and hyphens. This is the customer's own sub-site.</p>
      </div>
      <div className="field">
        <label htmlFor="host">Full host name (optional)</label>
        <input id="host" value={host} placeholder="acme.approvals.example.com" onChange={(e) => setHost(e.target.value)} />
        <p className="hint">Leave blank to use the standard address for this installation.</p>
      </div>
      <div className="field">
        <label htmlFor="adminEmail">First administrator's email</label>
        <input id="adminEmail" type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="adminName">First administrator's name</label>
        <input id="adminName" value={adminDisplayName} onChange={(e) => setAdminDisplayName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="fileRoot">Folder for this customer's files (optional)</label>
        <input id="fileRoot" className="mono" value={fileStorageRoot} placeholder="D:\CustomerFiles\Acme  or  \\fileserver\approvals\Acme" onChange={(e) => setFileStorageRoot(e.target.value)} />
        <p className="hint">Closed-request PDFs and approvers' attachments are saved there instead of the database. Leave blank to keep them in the database. The app checks it can write there before creating the customer.</p>
      </div>
      <div className="actions">
        <button className="primary" disabled={act.busy || !name.trim() || !adminEmail.trim() || adminDisplayName.trim().length < 2} onClick={() => void submit()}>
          {act.busy ? 'Creating…' : 'Create customer'}
        </button>
        <button className="link" onClick={() => { setOpen(false); reset(); }}>Cancel</button>
      </div>
    </section>
  );
}

export function Customers() {
  const tenants = useGlobalLoad<{ tenants: TenantSummary[] }>('/tenants');
  const stats = useGlobalLoad<Stats>('/stats');
  const reloadAll = () => { tenants.reload(); stats.reload(); };
  // set by the customer page after "Remove customer"
  const notice = (useLocation().state as { notice?: string } | null)?.notice;

  return (
    <>
      <div className="page-head"><h1>Customers</h1></div>
      {notice && <p className="notice">{notice}</p>}
      {stats.data && (
        <div className="tiles">
          <div className="tile"><span className="tile-n">{stats.data.totals.activeTenants}</span><span className="tile-label">Active customers</span></div>
          <div className="tile"><span className="tile-n">{stats.data.totals.users}</span><span className="tile-label">People</span></div>
          <div className="tile"><span className="tile-n">{stats.data.totals.openRequests}</span><span className="tile-label">Requests in progress</span></div>
          <div className="tile"><span className="tile-n">{stats.data.totals.failedEmails}</span><span className="tile-label">Failed emails</span></div>
        </div>
      )}

      <NewCustomer onCreated={reloadAll} />

      {tenants.error && <p className="notice error">{tenants.error}</p>}
      {!tenants.data ? (
        <p className="muted">Loading…</p>
      ) : tenants.data.tenants.length === 0 ? (
        <p className="muted">No customers yet.</p>
      ) : (
        <table className="sample-table">
          <thead>
            <tr><th>Customer</th><th>Address</th><th>People</th><th>Forms</th><th>Requests</th><th>Last activity</th><th /></tr>
          </thead>
          <tbody>
            {tenants.data.tenants.map((t) => (
              <tr key={t.tenantId}>
                <td>
                  <Link to={`/customers/${t.tenantId}`}>{t.name}</Link>
                  {t.removedAt ? (
                    <span className="badge badge-rejected" style={{ marginLeft: 8 }}>Removed, deleted on {new Date(t.purgeAfter ?? '').toLocaleDateString()}</span>
                  ) : (
                    !t.isActive && <span className="badge badge-rejected" style={{ marginLeft: 8 }}>Suspended</span>
                  )}
                </td>
                <td className="mono">{t.host ?? t.slug}</td>
                <td className="num">{t.counts.users}</td>
                <td className="num">{t.counts.forms}</td>
                <td className="num">{t.counts.requests} ({t.counts.openRequests} open)</td>
                <td>{fmt(t.lastActivityAt)}</td>
                <td><a href={t.url} target="_blank" rel="noreferrer">Open</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {stats.data && stats.data.recentActivity.length > 0 && (
        <section className="card stack">
          <h2>Recent management activity</h2>
          <table className="sample-table">
            <thead><tr><th>When</th><th>What</th><th>Customer</th><th>By</th></tr></thead>
            <tbody>
              {stats.data.recentActivity.map((a, i) => (
                <tr key={i}><td>{fmt(a.at)}</td><td className="mono">{a.action}</td><td>{a.tenantName ?? '—'}</td><td>{a.by ?? '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
