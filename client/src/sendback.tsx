// Send back for changes: what an approver asked for, and what the submitter changed when they resubmitted.
import { fmtDateTime, formatValue } from './fields';

export interface FieldChange { key: string; label: string; type: string; from: string | null; to: string | null }
export interface SendBack {
  stepOrder: number;
  stepName: string;
  returnedBy: string;
  returnedAt: string;
  reason: string;
  resubmittedAt: string | null;
  resubmitNote: string | null;
  changes: FieldChange[];
}

const show = (c: FieldChange, v: string | null) => formatValue({ key: c.key, label: c.label, type: c.type, value: v });

/** "Amount: 1,499.50 → 999.00", one line per changed field. */
export function ChangeList({ changes }: { changes: FieldChange[] }) {
  if (!changes.length) return <p className="muted small" style={{ margin: 0 }}>No values were changed.</p>;
  return (
    <ul className="changes">
      {changes.map((c) => (
        <li key={c.key}><strong>{c.label}:</strong> <span className="from">{show(c, c.from)}</span> → {show(c, c.to)}</li>
      ))}
    </ul>
  );
}

/** Every completed send-back round, oldest first (the open one is shown separately, as a call to action). */
export function SendBackHistory({ items, title = 'Sent back for changes' }: { items: SendBack[]; title?: string }) {
  const done = items.filter((x) => x.resubmittedAt);
  if (!done.length) return null;
  return (
    <section className="card">
      <h2>{title}</h2>
      <ol className="tracker">
        {done.map((x, i) => (
          <li key={i} className="tracker-returned">
            <strong>Step {x.stepOrder}: {x.stepName}</strong>
            <p className="muted small" style={{ margin: 0 }}>Sent back by {x.returnedBy} · {fmtDateTime(x.returnedAt)}</p>
            <blockquote>{x.reason}</blockquote>
            <p className="muted small" style={{ margin: 0 }}>Resubmitted {fmtDateTime(x.resubmittedAt)}</p>
            {x.resubmitNote && <blockquote>{x.resubmitNote}</blockquote>}
            <ChangeList changes={x.changes} />
          </li>
        ))}
      </ol>
    </section>
  );
}
