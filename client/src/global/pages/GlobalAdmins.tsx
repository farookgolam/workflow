// The people who run this installation: add another global administrator, deactivate or reactivate
// one, give one a new key - and change your own key.
import { useState } from 'react';
import { changeKey, gapi, type GlobalAdminSummary } from '../api';
import { useGlobalAuth } from '../auth';
import { useGlobalAction, useGlobalLoad } from '../hooks';

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

function KeyInput({ id, label, value, onChange, autoComplete }: { id: string; label: string; value: string; onChange(v: string): void; autoComplete: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="digits"
        type="password"
        inputMode="numeric"
        pattern="\d{6}"
        maxLength={6}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
      />
    </div>
  );
}

/** A generated key, shown once. */
function KeyShown({ who, keyValue, onDone }: { who: string; keyValue: string; onDone(): void }) {
  return (
    <p className="notice">
      Sign-in key for <strong>{who}</strong>: <strong className="mono">{keyValue}</strong>
      <br />
      This is shown once and is not stored anywhere in readable form. Pass it to them; they can change it after signing in.{' '}
      <button className="link" onClick={onDone}>Done</button>
    </p>
  );
}

function NewAdmin({ onCreated }: { onCreated(): void }) {
  const act = useGlobalAction();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [created, setCreated] = useState<{ email: string; key: string } | null>(null);

  const submit = () =>
    act.run(async () => {
      const res = await gapi<{ admin: GlobalAdminSummary; generatedKey: string }>('/admins', {
        method: 'POST',
        body: { email: email.trim(), displayName: displayName.trim() },
      });
      setCreated({ email: res.admin.email, key: res.generatedKey });
      setOpen(false);
      setEmail('');
      setDisplayName('');
      onCreated();
    });

  if (created) return <KeyShown who={created.email} keyValue={created.key} onDone={() => setCreated(null)} />;

  if (!open) {
    return (
      <div className="actions">
        <button className="primary" onClick={() => { act.clear(); setOpen(true); }}>New global administrator</button>
      </div>
    );
  }

  return (
    <section className="card stack">
      <h2>New global administrator</h2>
      <p className="hint">They can create, change, suspend and remove every customer, and manage the other global administrators.</p>
      {act.error && <p className="notice error">{act.error}</p>}
      <div className="field">
        <label htmlFor="ga-email">Email address</label>
        <input id="ga-email" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ga-name">Name</label>
        <input id="ga-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </div>
      <div className="actions">
        <button className="primary" disabled={act.busy || !email.trim() || displayName.trim().length < 2} onClick={() => void submit()}>
          {act.busy ? 'Creating…' : 'Create administrator'}
        </button>
        <button className="link" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </section>
  );
}

function ChangeMyKey() {
  const act = useGlobalAction();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');

  const submit = () =>
    act.run(async () => {
      await changeKey(current, next);
      setCurrent(''); setNext(''); setAgain('');
      return 'Your key has been changed. Any other session you had open has been signed out.';
    });

  return (
    <section className="card stack">
      <h2>Change my key</h2>
      {act.error && <p className="notice error">{act.error}</p>}
      {act.ok && <p className="notice">{act.ok}</p>}
      <KeyInput id="key-current" label="Current key" value={current} onChange={setCurrent} autoComplete="current-password" />
      <KeyInput id="key-new" label="New key" value={next} onChange={setNext} autoComplete="new-password" />
      <KeyInput id="key-again" label="New key again" value={again} onChange={setAgain} autoComplete="new-password" />
      {again.length === 6 && again !== next && <p className="hint">The two new keys do not match.</p>}
      <div className="actions">
        <button className="primary" disabled={act.busy || current.length !== 6 || next.length !== 6 || next !== again} onClick={() => void submit()}>
          {act.busy ? 'Saving…' : 'Change key'}
        </button>
      </div>
    </section>
  );
}

export function GlobalAdmins() {
  const { admin: me } = useGlobalAuth();
  const list = useGlobalLoad<{ admins: GlobalAdminSummary[] }>('/admins');
  const act = useGlobalAction();
  const [confirm, setConfirm] = useState<{ a: GlobalAdminSummary; what: 'deactivate' | 'reset' } | null>(null);
  const [shownKey, setShownKey] = useState<{ email: string; key: string } | null>(null);

  const setActive = (a: GlobalAdminSummary, isActive: boolean) =>
    act.run(async () => {
      await gapi(`/admins/${a.platformAdminId}`, { method: 'PATCH', body: { isActive } });
      setConfirm(null);
      list.reload();
      return isActive ? `${a.email} can sign in again.` : `${a.email} can no longer sign in, and their open sessions have ended.`;
    });

  const resetKey = (a: GlobalAdminSummary) =>
    act.run(async () => {
      const res = await gapi<{ generatedKey: string }>(`/admins/${a.platformAdminId}/reset-key`, { method: 'POST' });
      setConfirm(null);
      setShownKey({ email: a.email, key: res.generatedKey });
      list.reload();
    });

  return (
    <>
      <div className="page-head"><h1>Global administrators</h1></div>

      <NewAdmin onCreated={list.reload} />

      {shownKey && <KeyShown who={shownKey.email} keyValue={shownKey.key} onDone={() => setShownKey(null)} />}
      {act.error && <p className="notice error">{act.error}</p>}
      {act.ok && <p className="notice">{act.ok}</p>}
      {confirm && (
        <p className="notice">
          {confirm.what === 'deactivate'
            ? <>Deactivate {confirm.a.email}? They are signed out at once and cannot sign in until reactivated.</>
            : <>Give {confirm.a.email} a new key? Their current key stops working and they are signed out everywhere.</>}{' '}
          <button className="link" disabled={act.busy} onClick={() => void (confirm.what === 'deactivate' ? setActive(confirm.a, false) : resetKey(confirm.a))}>
            {confirm.what === 'deactivate' ? 'Yes, deactivate' : 'Yes, new key'}
          </button>{' '}
          <button className="link" onClick={() => setConfirm(null)}>Cancel</button>
        </p>
      )}

      {list.error && <p className="notice error">{list.error}</p>}
      {!list.data ? (
        <p className="muted">Loading…</p>
      ) : (
        <table className="sample-table">
          <thead>
            <tr><th>Name</th><th>Email</th><th>Status</th><th>Last sign-in</th><th>Added</th><th /></tr>
          </thead>
          <tbody>
            {list.data.admins.map((a) => {
              const isMe = a.platformAdminId === me?.platformAdminId;
              return (
                <tr key={a.platformAdminId}>
                  <td>{a.displayName}{isMe && <span className="muted"> (you)</span>}</td>
                  <td className="mono">{a.email}</td>
                  <td>
                    {!a.isActive ? <span className="badge badge-rejected">Deactivated</span> : a.locked ? <span className="badge badge-rejected">Locked</span> : 'Active'}
                  </td>
                  <td>{fmt(a.lastSignInAt)}</td>
                  <td>{new Date(a.createdAt).toLocaleDateString()}</td>
                  <td className="row-actions">
                    {!isMe && (a.isActive ? (
                      <>
                        <button className="link" disabled={act.busy} onClick={() => setConfirm({ a, what: 'reset' })}>New key</button>
                        <button className="link" disabled={act.busy} onClick={() => setConfirm({ a, what: 'deactivate' })}>Deactivate</button>
                      </>
                    ) : (
                      <button className="link" disabled={act.busy} onClick={() => void setActive(a, true)}>Reactivate</button>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <ChangeMyKey />
    </>
  );
}
