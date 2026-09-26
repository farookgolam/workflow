import { Link } from 'react-router-dom';
import { useLoad } from '../../hooks';

interface Dashboard {
  counts: { inProgress: number; approved: number; rejected: number; cancelled: number; overdue: number };
  failedNotifications: number;
  averageTimePerStep: { formName: string; stepOrder: number; stepName: string; decisions: number; avgHours: number }[];
}

const fmtHours = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);

export function AdminDashboard() {
  const { data, error } = useLoad<Dashboard>('/admin/dashboard');
  if (error) return <p className="notice bad">{error}</p>;
  if (!data) return <p className="muted center">Loading…</p>;
  const tiles: [string, number, string, string][] = [
    ['In progress', data.counts.inProgress, 'InProgress', ''],
    ['Approved', data.counts.approved, 'Approved', 'ok'],
    ['Rejected', data.counts.rejected, 'Rejected', 'bad'],
    ['Overdue', data.counts.overdue, 'Overdue', data.counts.overdue ? 'warn' : ''],
    ['Cancelled', data.counts.cancelled, 'Cancelled', ''],
  ];
  return (
    <div className="stack">
      <h1>Dashboard</h1>
      <div className="tiles">
        {tiles.map(([label, n, status, tone]) => (
          <Link key={status} to={`/admin/requests?status=${status}`} className={`tile ${tone}`}>
            <span className="tile-n">{n}</span>
            <span className="tile-label">{label}</span>
          </Link>
        ))}
      </div>
      {data.failedNotifications > 0 && (
        <p className="notice bad">{data.failedNotifications} email(s) could not be delivered after several attempts. Check the SMTP settings, then resend them from a request's detail page.</p>
      )}
      <section className="card">
        <h2>Average time per step</h2>
        {data.averageTimePerStep.length === 0 ? <p className="muted">No completed steps yet.</p> : (
          <table>
            <thead><tr><th>Form</th><th>Step</th><th className="num">Decisions</th><th className="num">Average time to decide</th></tr></thead>
            <tbody>
              {data.averageTimePerStep.map((s) => (
                <tr key={`${s.formName}-${s.stepOrder}-${s.stepName}`}>
                  <td>{s.formName}</td><td>{s.stepOrder}. {s.stepName}</td><td className="num">{s.decisions}</td><td className="num">{fmtHours(s.avgHours)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
