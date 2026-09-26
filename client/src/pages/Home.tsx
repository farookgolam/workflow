import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { fmtDateTime } from '../fields';
import { useLoad } from '../hooks';
import { MySubmissions } from './Requests';

interface Pending { requestStepId: number; requestNumber: string; formName: string; submitterName: string; stepOrder: number; totalSteps: number; stepName: string; activatedAt: string; dueAt: string | null; overdue: boolean }
interface FormSummary { formId: number; name: string; description: string | null }

export function HomePage() {
  const { user } = useAuth();
  const isApprover = user!.roles.includes('Approver') || user!.roles.includes('Admin');
  const isSubmitter = user!.roles.includes('Submitter');
  const pending = useLoad<{ approvals: Pending[] }>(isApprover ? '/approvals/pending' : null);
  const forms = useLoad<{ forms: FormSummary[] }>(isSubmitter ? '/forms' : null);

  return (
    <div className="stack">
      {isApprover && (
        <section className="card">
          <h2>Waiting for my approval</h2>
          {pending.error ? <p className="notice bad">{pending.error}</p> : !pending.data ? <p className="muted">Loading…</p> : pending.data.approvals.length === 0 ? <p className="muted">Nothing is waiting on you.</p> : (
            <table>
              <thead><tr><th>Request</th><th>Form</th><th>Submitted by</th><th>Step</th><th>Waiting since</th><th /></tr></thead>
              <tbody>
                {pending.data.approvals.map((p) => (
                  <tr key={p.requestStepId}>
                    <td><Link to={`/approvals/${p.requestStepId}`}>{p.requestNumber}</Link></td>
                    <td>{p.formName}</td>
                    <td>{p.submitterName}</td>
                    <td>{p.stepOrder} of {p.totalSteps} · {p.stepName}</td>
                    <td>{fmtDateTime(p.activatedAt)}</td>
                    <td>{p.overdue && <span className="badge badge-rejected">Overdue</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {isSubmitter && (
        <>
          <section className="card">
            <h2>Start a new request</h2>
            {!forms.data ? <p className="muted">Loading…</p> : forms.data.forms.length === 0 ? <p className="muted">No forms are available yet.</p> : (
              <div className="form-cards">
                {forms.data.forms.map((f) => (
                  <Link key={f.formId} to={`/requests/new/${f.formId}`} className="form-card">
                    <strong>{f.name}</strong>
                    {f.description && <span className="muted small">{f.description}</span>}
                  </Link>
                ))}
              </div>
            )}
          </section>
          <MySubmissions />
        </>
      )}

      {!isApprover && !isSubmitter && <div className="card"><p className="muted">Your account has no role assigned yet. Please contact your administrator.</p></div>}
    </div>
  );
}
