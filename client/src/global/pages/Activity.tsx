// What global administrators did in this console, newest first: the platform audit log, which records every action
// here and can never be changed.
import { useGlobalLoad } from '../hooks';

interface Stats {
  recentActivity: { at: string; action: string; tenantName: string | null; by: string | null }[];
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export function Activity() {
  const stats = useGlobalLoad<Stats>('/stats');
  const rows = stats.data?.recentActivity ?? [];
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="muted">The last 100 things global administrators did in this console, newest first. Nothing here can be changed or removed.</p>
        </div>
      </div>
      {stats.error && <p className="notice error">{stats.error}</p>}
      {!stats.data ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted">Nothing has been done here yet.</p>
      ) : (
        <section className="card">
          <table className="sample-table">
            <thead><tr><th>When</th><th>What</th><th>Customer</th><th>By</th></tr></thead>
            <tbody>
              {rows.map((a, i) => (
                <tr key={i}><td>{fmt(a.at)}</td><td className="mono">{a.action}</td><td>{a.tenantName ?? '—'}</td><td>{a.by ?? '—'}</td></tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
