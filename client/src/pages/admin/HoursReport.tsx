// The Hours report: timesheet lines (Date, School, Time In, Time Out, Worked Hour) for one submitter or everyone,
// over one day or a range of days worked. The server does the work (server/src/reports/hours.ts); this page picks
// the form, the person and the dates, shows the result and exports it. The last choices are remembered per browser.
import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { api, download } from '../../api';
import { usDate } from '../../dates';
import { useAction, useLoad } from '../../hooks';

interface GridColumn { key: string; label: string; type: string }
interface Mapping { date: string; school: string | null; timeIn: string | null; timeOut: string | null; worked: string | null }
interface HoursForm { formId: number; name: string; grid: string; gridLabel: string; columns: GridColumn[]; mapping: Mapping; fields: GridColumn[] }
interface Line { kind: 'line' | 'subtotal' | 'total'; submitter: string; extra: (string | null)[]; date: string | null; school: string | null; timeIn: string | null; timeOut: string | null; hours: number | null; requestNumber: string | null; days?: number }
interface Result { form: string; from: string; to: string; submitter: string | null; includeInProgress: boolean; extraColumns: { key: string; label: string }[]; lines: Line[]; totalHours: number; lineCount: number; people: number; truncated: boolean }

/** Switches between the report builder and the Hours report. */
export function ReportTabs() {
  return (
    <nav className="seg b-mode" aria-label="Reports">
      <NavLink to="/admin/reports" end className={({ isActive }) => (isActive ? 'on' : '')}>Report builder</NavLink>
      <NavLink to="/admin/reports/hours" className={({ isActive }) => (isActive ? 'on' : '')}>Hours</NavLink>
    </nav>
  );
}

const STORE = 'hoursReport';
const remembered = (): Partial<{ formId: number; submitterUserId: number | null; range: boolean; from: string; to: string; includeInProgress: boolean; mappings: Record<number, Mapping>; fields: Record<number, string[]> }> => {
  try { return JSON.parse(localStorage.getItem(STORE) ?? '{}'); } catch { return {}; }
};
const remember = (v: object) => { try { localStorage.setItem(STORE, JSON.stringify({ ...remembered(), ...v })); } catch { /* private window: not remembered */ } };

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
/** Handy ranges; weeks start on Monday. */
function quickRanges(): [string, string, string][] {
  const today = new Date();
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const first = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastMonthFirst = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return [
    ['This week', iso(monday), iso(addDays(monday, 6))],
    ['Last week', iso(addDays(monday, -7)), iso(addDays(monday, -1))],
    ['This month', iso(first), iso(new Date(today.getFullYear(), today.getMonth() + 1, 0))],
    ['Last month', iso(lastMonthFirst), iso(addDays(first, -1))],
  ];
}
const fmtHours = (n: number | null) => (n === null ? '' : n.toFixed(2));
const fmtDate = (d: string | null) => usDate(d);
const ROLES: [keyof Mapping, string, (c: GridColumn) => boolean][] = [
  ['date', 'Date', (c) => c.type === 'date'],
  ['school', 'School', (c) => c.type === 'text' || c.type === 'select'],
  ['timeIn', 'Time In', (c) => c.type === 'time'],
  ['timeOut', 'Time Out', (c) => c.type === 'time'],
  ['worked', 'Worked Hour', (c) => ['number', 'currency', 'calc'].includes(c.type)],
];

export function AdminHoursReport() {
  const forms = useLoad<{ forms: HoursForm[] }>('/admin/reports/hours/forms');
  const saved = remembered();
  const [formId, setFormId] = useState<number | null>(saved.formId ?? null);
  const form = forms.data?.forms.find((f) => f.formId === formId) ?? null;
  const submitters = useLoad<{ submitters: { userId: number; displayName: string; email: string }[] }>(form ? `/admin/reports/hours/submitters?formId=${form.formId}` : null);
  const [submitterUserId, setSubmitterUserId] = useState<number | null>(saved.submitterUserId ?? null);
  const [range, setRange] = useState(saved.range ?? true);
  const [from, setFrom] = useState(saved.from ?? quickRanges()[0][1]);
  const [to, setTo] = useState(saved.to ?? quickRanges()[0][2]);
  const [includeInProgress, setIncludeInProgress] = useState(saved.includeInProgress ?? false);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [fields, setFields] = useState<string[]>([]); // extra columns: fields of the form itself
  const [result, setResult] = useState<Result | null>(null);
  const act = useAction();

  // pick the only form, or the remembered one if it still exists; its column mapping follows it
  useEffect(() => {
    const list = forms.data?.forms;
    if (!list) return;
    const f = list.find((x) => x.formId === formId) ?? (list.length === 1 ? list[0] : null);
    if (f?.formId !== formId) setFormId(f?.formId ?? null);
    const m = f ? remembered().mappings?.[f.formId] : undefined;
    setMapping(f ? (m && f.columns.some((c) => c.key === m.date) ? m : f.mapping) : null);
    // the remembered extra columns that are still on the form
    setFields(f ? (remembered().fields?.[f.formId] ?? []).filter((k) => f.fields.some((x) => x.key === k)) : []);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forms.data, formId]);
  // a remembered submitter who has not submitted this form is dropped
  useEffect(() => {
    if (submitters.data && submitterUserId && !submitters.data.submitters.some((u) => u.userId === submitterUserId)) setSubmitterUserId(null);
  }, [submitters.data, submitterUserId]);

  const query = form && mapping ? { formId: form.formId, mapping, submitterUserId, from, to: range ? to : null, includeInProgress, fields } : null;
  const changed = <T,>(set: (v: T) => void) => (v: T) => { set(v); setResult(null); };
  const run = () => act.run(async () => {
    if (!query) return;
    remember({ formId: query.formId, submitterUserId, range, from, to, includeInProgress, mappings: { ...remembered().mappings, [query.formId]: mapping }, fields: { ...remembered().fields, [query.formId]: fields } });
    setResult(await api<Result>('/admin/reports/hours/run', { method: 'POST', body: query }));
  });
  const exportIt = (format: 'csv' | 'xlsx') => act.run(() => download('/admin/reports/hours/export', `hours.${format}`, { query, format }));
  const everyone = result ? result.submitter === null : submitterUserId === null;

  return (
    <div className="stack">
      <h1>Reports</h1>
      <ReportTabs />
      {act.error && <p className="notice bad" role="alert">{act.error}</p>}

      <section className="card">
        <h2>Hours worked</h2>
        <p className="muted">The lines of a timesheet form - Date, School, Time In, Time Out and Worked Hour, plus any extra columns you choose from the form - for one person or everyone, by the <strong>day worked</strong>.</p>
        {forms.error ? <p className="notice bad">{forms.error}</p> : !forms.data ? <p className="muted">Loading…</p> : forms.data.forms.length === 0 ? (
          <p className="notice">No form has a timesheet grid yet: a data grid with a <strong>Date</strong> column and <strong>Time In</strong> / <strong>Time Out</strong> (or <strong>Worked Hour</strong>) columns.</p>
        ) : (
          <>
            <div className="grid2">
              <label>Form
                <select value={formId ?? ''} onChange={(e) => { setFormId(e.target.value ? Number(e.target.value) : null); setSubmitterUserId(null); }}>
                  <option value="">Choose…</option>
                  {forms.data.forms.map((f) => <option key={f.formId} value={f.formId}>{f.name}</option>)}
                </select>
              </label>
              <label>Submitter
                <select value={submitterUserId ?? ''} disabled={!form} onChange={(e) => changed(setSubmitterUserId)(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">All submitters</option>
                  {submitters.data?.submitters.map((u) => <option key={u.userId} value={u.userId}>{u.displayName}</option>)}
                </select>
              </label>
            </div>

            <div className="hr-dates">
              <div className="seg" role="group" aria-label="Dates">
                <button type="button" className={!range ? 'on' : ''} aria-pressed={!range} onClick={() => changed(setRange)(false)}>Single day</button>
                <button type="button" className={range ? 'on' : ''} aria-pressed={range} onClick={() => changed(setRange)(true)}>Date range</button>
              </div>
              <label>{range ? 'From' : 'Day'}<input type="date" value={from} onChange={(e) => changed(setFrom)(e.target.value)} /></label>
              {range && <label>To<input type="date" value={to} min={from} onChange={(e) => changed(setTo)(e.target.value)} /></label>}
              {range && (
                <span className="hr-quick">
                  {quickRanges().map(([label, a, b]) => <button type="button" key={label} className="link" onClick={() => { setFrom(a); setTo(b); setResult(null); }}>{label}</button>)}
                </span>
              )}
            </div>

            <label className="check"><input type="checkbox" checked={includeInProgress} onChange={(e) => changed(setIncludeInProgress)(e.target.checked)} /><span>Also count timesheets still waiting for approval</span></label>
            <p className="hint" style={{ marginTop: 0 }}>Otherwise only approved timesheets count. Rejected and cancelled ones never do.</p>

            {form && mapping && (
              <details className="hr-map">
                <summary className="small">Columns used from "{form.gridLabel}"</summary>
                <div className="hr-map-grid">
                  {ROLES.map(([role, label, fits]) => (
                    <label key={role}>{label}
                      <select value={mapping[role] ?? ''} onChange={(e) => changed(setMapping)({ ...mapping, [role]: e.target.value || null } as Mapping)}>
                        {role !== 'date' && <option value="">(none)</option>}
                        {form.columns.filter(fits).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                      </select>
                    </label>
                  ))}
                </div>
                <p className="hint">Guessed from the column headings. Worked Hour is the value on the timesheet; where it is missing or negative (a shift past midnight) it is worked out from Time In and Time Out. <button type="button" className="link" onClick={() => changed(setMapping)(form.mapping)}>Reset</button></p>
              </details>
            )}

            {form && form.fields.length > 0 && (
              <fieldset className="b-auto">
                <legend>Extra columns from the form</legend>
                <div>
                  {form.fields.map((f) => (
                    <label key={f.key} className="check inline">
                      <input type="checkbox" checked={fields.includes(f.key)} disabled={!fields.includes(f.key) && fields.length >= 10}
                        onChange={() => changed(setFields)(fields.includes(f.key) ? fields.filter((k) => k !== f.key) : [...fields, f.key])} />
                      <span>{f.label}</span>
                    </label>
                  ))}
                </div>
                <p className="hint" style={{ marginBottom: 0 }}>Fields filled in once per timesheet (outside "{form.gridLabel}"), shown on each of its lines and in the export. Up to 10.</p>
              </fieldset>
            )}

            <div className="actions">
              <button className="primary" disabled={!query || act.busy || !from || (range && (!to || to < from))} onClick={() => void run()}>{act.busy ? 'Working…' : 'Run report'}</button>
              {result && <>
                <button disabled={act.busy} onClick={() => void exportIt('xlsx')}>Export to Excel</button>
                <button disabled={act.busy} onClick={() => void exportIt('csv')}>Export to CSV</button>
              </>}
            </div>
            {range && to < from && <p className="field-error">The end date is before the start date.</p>}
          </>
        )}
      </section>

      {result && (
        <section className="card">
          <div className="prev-head">
            <h2 style={{ margin: 0 }}>{result.submitter ?? 'All submitters'}, {result.from === result.to ? fmtDate(result.from) : `${fmtDate(result.from)} – ${fmtDate(result.to)}`}</h2>
            <span className="hr-total">{fmtHours(result.totalHours)} hours</span>
          </div>
          <p className="muted small">{result.lineCount} line(s){everyone && `, ${result.people} person(s)`}, {result.includeInProgress ? 'approved and in-progress' : 'approved'} timesheets of {result.form}</p>
          {result.truncated && <p className="notice">Only the most recent 20,000 timesheets were read. Choose one submitter to be sure nothing is missed.</p>}
          {result.lineCount === 0 ? <p className="muted">Nobody recorded hours on {result.from === result.to ? 'that day' : 'those days'}.</p> : (
            <div className="table-wrap">
              <table className="hr-table">
                <thead><tr>{everyone && <th>Submitter</th>}{result.extraColumns.map((c) => <th key={c.key}>{c.label}</th>)}<th>Date</th><th>School</th><th>Time In</th><th>Time Out</th><th className="num">Worked Hour</th><th>Request</th></tr></thead>
                <tbody>{result.lines.map((l, i) => l.kind === 'line' ? (
                  <tr key={i}>{everyone && <td>{l.submitter}</td>}{l.extra.map((v, j) => <td key={j}>{v}</td>)}<td>{fmtDate(l.date)}</td><td>{l.school}</td><td>{l.timeIn}</td><td>{l.timeOut}</td><td className="num">{fmtHours(l.hours)}</td><td className="muted small">{l.requestNumber}</td></tr>
                ) : (
                  <tr key={i} className={`hr-${l.kind}`}>
                    {everyone && <td>{l.kind === 'total' ? 'Total' : `Subtotal - ${l.submitter}`}</td>}
                    <td colSpan={4 + result.extraColumns.length}>{everyone ? `${l.days} day(s)` : `Total, ${l.days} day(s)`}</td>
                    <td className="num">{fmtHours(l.hours)}</td><td />
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
