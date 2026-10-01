// "Export PDFs": one form's finished requests, submitted in a date range, downloaded as one ZIP of PDFs plus
// Index.xlsx. Shared by the customer's administrators (Requests page) and global administrators (customer page);
// each passes how to call its own API (server/src/archive/export.ts).
import { useState } from 'react';

export interface ExportForm { formId: number; name: string; deleted?: boolean }
export interface ExportQuery { formId: number; from: string; to: string; status: 'Both' | 'Approved' | 'Rejected' }
interface Preview { form: string; pdfs: number; pending: number; max: number; fileName: string }

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const exportParams = (q: ExportQuery) => new URLSearchParams({ formId: String(q.formId), from: q.from, to: q.to, status: q.status }).toString();

export function PdfExport({ forms, preview, download, onClose }: {
  forms: ExportForm[];
  preview(q: ExportQuery): Promise<Preview>;
  download(q: ExportQuery, fileName: string): Promise<void>;
  onClose?(): void;
}) {
  const now = new Date();
  const [formId, setFormId] = useState('');
  const [from, setFrom] = useState(ymd(new Date(now.getFullYear(), now.getMonth(), 1))); // this month so far
  const [to, setTo] = useState(ymd(now));
  const [status, setStatus] = useState<ExportQuery['status']>('Both');
  const [checked, setChecked] = useState<Preview | null>(null);
  const [busy, setBusy] = useState<'' | 'check' | 'download'>('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const query = (): ExportQuery | null => (formId ? { formId: Number(formId), from, to, status } : null);
  const changed = <T,>(set: (v: T) => void) => (v: T) => { set(v); setChecked(null); setDone(''); setError(''); };
  const run = async (what: 'check' | 'download') => {
    const q = query();
    if (!q) return setError('Choose a form.');
    if (from > to) return setError('The From date must not be after the To date.');
    setBusy(what); setError(''); setDone('');
    try {
      if (what === 'check') setChecked(await preview(q));
      else { await download(q, checked?.fileName ?? 'export.zip'); setDone(`Downloaded ${checked?.pdfs ?? ''} PDF(s) with Index.xlsx.`); }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy('');
    }
  };
  const tooMany = !!checked && checked.pdfs > checked.max;

  return (
    <section className="card stack">
      <div className="prev-head">
        <h2 style={{ margin: 0 }}>Export PDFs</h2>
        {onClose && <button className="link" onClick={onClose}>Close</button>}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        One form's approved and/or rejected requests, by the date they were <strong>submitted</strong>: a ZIP with every PDF and an Excel file <strong>Index.xlsx</strong> listing each one - file name (a link to the PDF), request, status, people, dates, approval steps and the form's own fields. At most 500 PDFs at a time.
      </p>
      <div className="filters">
        <label>Form<select value={formId} disabled={!!busy} onChange={(e) => changed(setFormId)(e.target.value)}>
          <option value="">Choose…</option>
          {forms.map((f) => <option key={f.formId} value={f.formId}>{f.name}{f.deleted ? ' (deleted)' : ''}</option>)}
        </select></label>
        <label>Submitted from<input type="date" value={from} disabled={!!busy} onChange={(e) => changed(setFrom)(e.target.value)} /></label>
        <label>to<input type="date" value={to} disabled={!!busy} onChange={(e) => changed(setTo)(e.target.value)} /></label>
        <label>Outcome<select value={status} disabled={!!busy} onChange={(e) => changed(setStatus)(e.target.value as ExportQuery['status'])}>
          <option value="Both">Approved and rejected</option><option value="Approved">Approved only</option><option value="Rejected">Rejected only</option>
        </select></label>
      </div>

      {error && <p className="notice bad" role="alert">{error}</p>}
      {done && <p className="notice ok" role="status">{done}</p>}
      {checked && !error && (
        <p className={`notice ${checked.pdfs === 0 || tooMany ? 'bad' : ''}`} role="status">
          {checked.pdfs === 0 ? <>No PDFs match: no finished <strong>{checked.form}</strong> requests were submitted in that range.</>
            : tooMany ? <><strong>{checked.pdfs} PDFs</strong> match - at most {checked.max} can be exported at a time. Choose a shorter date range.</>
            : <><strong>{checked.pdfs} PDF{checked.pdfs === 1 ? '' : 's'}</strong> will be exported as <strong>{checked.fileName}</strong>.</>}
          {checked.pending > 0 && <> {checked.pending} finished request{checked.pending === 1 ? ' has' : 's have'} no PDF yet (it is made within a minute) and {checked.pending === 1 ? 'is' : 'are'} not included.</>}
        </p>
      )}

      <div className="actions">
        <button disabled={!!busy || !formId} onClick={() => void run('check')}>{busy === 'check' ? 'Checking…' : 'Check'}</button>
        <button className="primary" disabled={!!busy || !checked || checked.pdfs === 0 || tooMany} onClick={() => void run('download')}>
          {busy === 'download' ? 'Preparing the ZIP…' : 'Download ZIP'}
        </button>
      </div>
      {busy === 'download' && <p className="muted small" style={{ margin: 0 }}>Hundreds of PDFs can take a minute - keep this page open.</p>}
    </section>
  );
}
