// Reports: choose a form, the columns to show, filters, and optionally how to group and summarise; run it on
// screen, export it to CSV or Excel, and save it to run again later. The server does the work
// (server/src/reports/engine.ts); this page only builds the definition and shows the result.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, download } from '../../api';
import { useAction, useLoad } from '../../hooks';
import { ReportTabs } from './HoursReport';
import { myTimeZone, usDate, usDateTime } from '../../dates';

type ColumnType = 'text' | 'number' | 'date' | 'datetime';
interface CatalogColumn { ref: string; label: string; type: ColumnType; group: string; retired?: boolean }
interface Catalog { formId: number; formName: string; columns: CatalogColumn[]; grids: { key: string; label: string; columns: CatalogColumn[] }[] }
type Op = 'eq' | 'ne' | 'contains' | 'gt' | 'ge' | 'lt' | 'le' | 'between' | 'empty' | 'notEmpty';
type Agg = 'sum' | 'avg' | 'min' | 'max' | 'count';
interface Definition {
  formId: number;
  lineItems: string | null;
  columns: { ref: string; agg?: Agg }[];
  filters: { ref: string; op: Op; value?: string; value2?: string }[];
  submittedFrom: string | null;
  submittedTo: string | null;
  statuses: string[];
  groupBy: string | null;
  groupPeriod: 'day' | 'week' | 'month' | 'year' | null;
  sort: { ref: string; dir: 'asc' | 'desc' } | null;
}
type Cell = string | number | null;
interface Result { columns: { key: string; label: string; type: ColumnType }[]; rows: Cell[][]; totals: Cell[] | null; records: number; truncated: boolean; shownRows: number }
interface Saved { reportId: number; name: string; formId: number; formName: string; updatedAt: string; updatedBy: string | null }

const STATUSES = [['InProgress', 'In progress'], ['Approved', 'Approved'], ['Rejected', 'Rejected'], ['Cancelled', 'Cancelled']] as const;
const OP_LABEL: Record<Op, string> = { eq: 'is', ne: 'is not', contains: 'contains', gt: 'is more than', ge: 'is at least', lt: 'is less than', le: 'is at most', between: 'is between', empty: 'is empty', notEmpty: 'is filled in' };
const DATE_OP_LABEL: Partial<Record<Op, string>> = { gt: 'is after', ge: 'is on or after', lt: 'is before', le: 'is on or before' };
const opsFor = (t: ColumnType): Op[] => (t === 'text' ? ['eq', 'ne', 'contains', 'empty', 'notEmpty'] : ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'between', 'empty', 'notEmpty']);
const AGG_LABEL: Record<Agg, string> = { sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest', count: 'Count' };
const blank = (formId: number): Definition => ({ formId, lineItems: null, columns: [{ ref: 'req.number' }, { ref: 'req.status' }, { ref: 'req.submittedAt' }], filters: [], submittedFrom: null, submittedTo: null, statuses: [], groupBy: null, groupPeriod: null, sort: null });

function show(v: Cell, type: ColumnType): string {
  if (v === null || v === '') return '';
  if (typeof v === 'number') return v.toLocaleString(undefined, { maximumFractionDigits: 6 });
  if (type === 'datetime') return usDateTime(v);
  if (type === 'date') return usDate(v);
  return v;
}

/** A horizontal bar per group, for a grouped report: its first summary column (or the count). */
function BarChart({ result }: { result: Result }) {
  const valueCol = result.columns.findIndex((c, i) => i >= 2 && c.type === 'number');
  const col = valueCol === -1 ? 1 : valueCol;
  const bars = result.rows.slice(0, 30).map((r) => ({ label: String(r[0] ?? ''), value: typeof r[col] === 'number' ? (r[col] as number) : 0 }));
  const max = Math.max(1, ...bars.map((b) => Math.abs(b.value)));
  if (!bars.length) return null;
  const rowH = 26, labelW = 170, width = 640;
  return (
    <figure style={{ margin: '0 0 1rem' }}>
      <figcaption className="small muted">{result.columns[col].label}{result.rows.length > 30 && ' (first 30 groups)'}</figcaption>
      <svg viewBox={`0 0 ${width} ${bars.length * rowH + 4}`} style={{ width: '100%', maxWidth: width }} role="img" aria-label={`Bar chart of ${result.columns[col].label}`}>
        {bars.map((b, i) => {
          const w = Math.max(1, (Math.abs(b.value) / max) * (width - labelW - 90));
          return (
            <g key={i} transform={`translate(0 ${i * rowH + 2})`}>
              <text x={labelW - 8} y={rowH / 2 + 4} textAnchor="end" fontSize="12" fill="currentColor">{b.label.length > 24 ? `${b.label.slice(0, 23)}…` : b.label}</text>
              <rect x={labelW} y={4} width={w} height={rowH - 8} rx={3} fill="var(--accent)" opacity={0.85} />
              <text x={labelW + w + 6} y={rowH / 2 + 4} fontSize="12" fill="currentColor">{b.value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export function AdminReports() {
  const forms = useLoad<{ forms: { formId: number; name: string; isActive: boolean; requests: number }[] }>('/admin/reports/forms');
  const saved = useLoad<{ reports: Saved[] }>('/admin/reports/saved');
  const act = useAction();
  const [def, setDef] = useState<Definition | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [current, setCurrent] = useState<{ reportId: number | null; name: string }>({ reportId: null, name: '' });
  const [adding, setAdding] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<Saved | null>(null);
  // opening a saved report brings its editor (below the list) into view
  const editorRef = useRef<HTMLElement>(null);
  const [scrollToEditor, setScrollToEditor] = useState(false);
  useEffect(() => {
    if (!scrollToEditor || !editorRef.current) return;
    editorRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setScrollToEditor(false);
  }, [scrollToEditor, def, catalog]);

  // the catalog follows the chosen form
  useEffect(() => {
    if (!def) return;
    if (catalog?.formId === def.formId) return;
    void act.run(async () => setCatalog(await api<Catalog>(`/admin/reports/catalog?formId=${def.formId}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def?.formId]);

  const available = useMemo(() => {
    if (!catalog || !def) return [] as CatalogColumn[];
    const grid = catalog.grids.find((g) => g.key === def.lineItems);
    return [...catalog.columns, ...(grid ? grid.columns.map((c) => ({ ...c, group: `${grid.label} (each line)` })) : [])];
  }, [catalog, def]);
  const colOf = (ref: string) => available.find((c) => c.ref === ref);
  const groups = [...new Set(available.map((c) => c.group))];
  const options = (filter: (c: CatalogColumn) => boolean = () => true) =>
    groups.map((g) => (
      <optgroup key={g} label={g}>
        {available.filter((c) => c.group === g && filter(c)).map((c) => <option key={c.ref} value={c.ref}>{c.label}</option>)}
      </optgroup>
    ));

  const patch = (p: Partial<Definition>) => { setDef((d) => (d ? { ...d, ...p } : d)); setResult(null); };
  const newReport = (formId: number) => { setDef(blank(formId)); setResult(null); setCurrent({ reportId: null, name: '' }); act.clear(); };
  const openSaved = (s: Saved) =>
    act.run(async () => {
      const r = await api<{ reportId: number; name: string; definition: Definition }>(`/admin/reports/saved/${s.reportId}`);
      setDef(r.definition);
      setCurrent({ reportId: r.reportId, name: r.name });
      setScrollToEditor(true);
      setResult(await api<Result>('/admin/reports/run', { method: 'POST', body: { definition: r.definition } }));
    });
  const runIt = () => act.run(async () => { setResult(await api<Result>('/admin/reports/run', { method: 'POST', body: { definition: def } })); });
  const exportIt = (format: 'csv' | 'xlsx') => act.run(() => download('/admin/reports/export', `report.${format}`, { definition: def, format, name: current.name || undefined, timeZone: myTimeZone() }));
  const save = (asNew: boolean) =>
    act.run(async () => {
      const name = current.name.trim();
      if (!name) throw new ApiError(400, 'name', 'Give the report a name first.');
      if (current.reportId && !asNew) {
        await api(`/admin/reports/saved/${current.reportId}`, { method: 'PUT', body: { name, definition: def } });
      } else {
        const r = await api<{ reportId: number }>('/admin/reports/saved', { method: 'POST', body: { name, definition: def } });
        setCurrent({ reportId: r.reportId, name });
      }
      saved.reload();
      return `"${name}" is saved.`;
    });
  const remove = (s: Saved) =>
    act.run(async () => {
      await api(`/admin/reports/saved/${s.reportId}`, { method: 'DELETE' });
      setConfirmDelete(null);
      if (current.reportId === s.reportId) setCurrent({ reportId: null, name: current.name });
      saved.reload();
      return `"${s.name}" was deleted.`;
    });

  const move = (i: number, d: number) => {
    const cols = [...def!.columns];
    [cols[i], cols[i + d]] = [cols[i + d], cols[i]];
    patch({ columns: cols });
  };
  const grouped = !!def?.groupBy;
  const groupCol = def?.groupBy ? colOf(def.groupBy) : undefined;

  return (
    <div className="stack">
      <h1>Reports</h1>
      <ReportTabs />
      {act.error && <p className="notice bad" role="alert">{act.error}</p>}
      {act.ok && <p className="notice ok" role="status">{act.ok}</p>}

      <section className="card">
        <h2>Saved reports</h2>
        {!saved.data ? <p className="muted">Loading…</p> : saved.data.reports.length === 0 ? <p className="muted">None yet. Build a report below and save it to run it again later.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Form</th><th>Last changed</th><th /></tr></thead>
            <tbody>{saved.data.reports.map((s) => (
              <tr key={s.reportId}>
                <td><button className="link" onClick={() => void openSaved(s)}>{s.name}</button></td>
                <td>{s.formName}</td>
                <td className="muted small">{usDateTime(s.updatedAt)}{s.updatedBy && `, ${s.updatedBy}`}</td>
                <td className="row-actions">
                  {confirmDelete?.reportId === s.reportId
                    ? <><button className="link danger-link" onClick={() => void remove(s)}>Yes, delete</button><button className="link" onClick={() => setConfirmDelete(null)}>Cancel</button></>
                    : <><button className="link" onClick={() => void openSaved(s)}>Edit</button><button className="link danger-link" onClick={() => setConfirmDelete(s)}>Delete</button></>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <div className="field" style={{ marginTop: '1rem', maxWidth: 420 }}>
          <label htmlFor="newForm">New report on the form</label>
          <select id="newForm" value="" onChange={(e) => e.target.value && newReport(Number(e.target.value))}>
            <option value="">Choose a form…</option>
            {(forms.data?.forms ?? []).map((f) => <option key={f.formId} value={f.formId}>{f.name} ({f.requests} request{f.requests === 1 ? '' : 's'}){f.isActive ? '' : ' - switched off'}</option>)}
          </select>
        </div>
      </section>

      {def && catalog && (
        <section className="card stack" ref={editorRef} style={{ scrollMarginTop: '1rem' }}>
          <div className="prev-head">
            <h2 style={{ margin: 0 }}>{current.reportId ? current.name : 'New report'} <span className="muted small">· {catalog.formName}</span></h2>
            <button className="link" onClick={() => { setDef(null); setResult(null); }}>Close</button>
          </div>

          {catalog.grids.length > 0 && (
            <div className="field">
              <label htmlFor="rowsPer">One row for each</label>
              <select id="rowsPer" value={def.lineItems ?? ''} onChange={(e) => {
                const lineItems = e.target.value || null;
                const keep = (ref: string) => !ref.startsWith('g.') || !!lineItems;
                patch({ lineItems, columns: def.columns.filter((c) => keep(c.ref)), filters: def.filters.filter((f) => keep(f.ref)), groupBy: def.groupBy && keep(def.groupBy) ? def.groupBy : null, sort: def.sort && keep(def.sort.ref) ? def.sort : null });
              }}>
                <option value="">Request</option>
                {catalog.grids.map((g) => <option key={g.key} value={g.key}>Line of the data grid "{g.label}"</option>)}
              </select>
              <p className="hint">Choose a data grid to list its lines (for example every purchase line), each with its request's details.</p>
            </div>
          )}

          <fieldset className="b-auto">
            <legend>Columns</legend>
            {current.reportId && <p className="hint">To add a field, choose it below and click Add, then Save changes at the bottom.</p>}
            {def.columns.length === 0 && <p className="muted small">Add at least one column.</p>}
            <ol style={{ margin: 0, paddingLeft: '1.2rem' }}>
              {def.columns.map((c, i) => {
                const col = colOf(c.ref);
                const agg = c.agg ?? (col?.type === 'number' ? 'sum' : 'count');
                return (
                  <li key={`${c.ref}-${i}`} style={{ marginBottom: '.3rem' }}>
                    <span className="b-row" style={{ gap: '.5rem', alignItems: 'center', display: 'inline-flex', flexWrap: 'wrap' }}>
                      <span>{col?.label ?? c.ref}{col && <span className="muted small">, {col.group}</span>}</span>
                      {grouped && c.ref !== def.groupBy && (
                        <select aria-label={`Summary of ${col?.label}`} value={agg} onChange={(e) => patch({ columns: def.columns.map((x, j) => (j === i ? { ...x, agg: e.target.value as Agg } : x)) })} style={{ width: 'auto' }}>
                          {(col?.type === 'number' ? (['sum', 'avg', 'min', 'max', 'count'] as Agg[]) : (['count'] as Agg[])).map((a) => <option key={a} value={a}>{AGG_LABEL[a]}</option>)}
                        </select>
                      )}
                      <button type="button" className="link" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                      <button type="button" className="link" disabled={i === def.columns.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                      <button type="button" className="link danger-link" onClick={() => patch({ columns: def.columns.filter((_, j) => j !== i) })} aria-label="Remove column">✕</button>
                    </span>
                  </li>
                );
              })}
            </ol>
            <div style={{ display: 'flex', gap: '.5rem', marginTop: '.5rem' }}>
              <select aria-label="Column to add" value={adding} onChange={(e) => setAdding(e.target.value)}>
                <option value="">Choose a column to add…</option>
                {options()}
              </select>
              <button type="button" style={{ width: 'auto' }} disabled={!adding} onClick={() => { patch({ columns: [...def.columns, { ref: adding }] }); setAdding(''); }}>Add</button>
            </div>
          </fieldset>

          <fieldset className="b-auto">
            <legend>Filters</legend>
            <div className="grid2">
              <label>Submitted from<input type="date" value={def.submittedFrom ?? ''} onChange={(e) => patch({ submittedFrom: e.target.value || null })} /></label>
              <label>Submitted to<input type="date" value={def.submittedTo ?? ''} onChange={(e) => patch({ submittedTo: e.target.value || null })} /></label>
            </div>
            <div className="b-row" style={{ gap: '1rem', flexWrap: 'wrap', display: 'flex', margin: '.5rem 0' }}>
              <span className="small muted">Status:</span>
              {STATUSES.map(([v, l]) => (
                <label key={v} className="check plain"><input type="checkbox" checked={def.statuses.includes(v)} onChange={(e) => patch({ statuses: e.target.checked ? [...def.statuses, v] : def.statuses.filter((s) => s !== v) })} /><span>{l}</span></label>
              ))}
              {def.statuses.length === 0 && <span className="small muted">(all)</span>}
            </div>
            {def.filters.map((f, i) => {
              const col = colOf(f.ref);
              const t = col?.type ?? 'text';
              const set = (p: Partial<Definition['filters'][number]>) => patch({ filters: def.filters.map((x, j) => (j === i ? { ...x, ...p } : x)) });
              const inputType = t === 'number' ? 'number' : t === 'date' || t === 'datetime' ? 'date' : 'text';
              return (
                <div key={i} style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '.4rem' }}>
                  <select aria-label="Filter column" value={f.ref} onChange={(e) => set({ ref: e.target.value, op: opsFor(colOf(e.target.value)?.type ?? 'text')[0] })} style={{ width: 'auto', maxWidth: 260 }}>{options()}</select>
                  <select aria-label="Condition" value={f.op} onChange={(e) => set({ op: e.target.value as Op })} style={{ width: 'auto' }}>
                    {opsFor(t).map((o) => <option key={o} value={o}>{(t !== 'text' && t !== 'number' && DATE_OP_LABEL[o]) || OP_LABEL[o]}</option>)}
                  </select>
                  {f.op !== 'empty' && f.op !== 'notEmpty' && <input aria-label="Value" type={inputType} step="any" value={f.value ?? ''} onChange={(e) => set({ value: e.target.value })} style={{ width: 160 }} />}
                  {f.op === 'between' && <><span className="small">and</span><input aria-label="Second value" type={inputType} step="any" value={f.value2 ?? ''} onChange={(e) => set({ value2: e.target.value })} style={{ width: 160 }} /></>}
                  <button type="button" className="link danger-link" onClick={() => patch({ filters: def.filters.filter((_, j) => j !== i) })} aria-label="Remove filter">✕</button>
                </div>
              );
            })}
            <button type="button" style={{ width: 'auto' }} onClick={() => { const first = available.find((c) => c.group !== 'Request') ?? available[0]; patch({ filters: [...def.filters, { ref: first.ref, op: opsFor(first.type)[0], value: '' }] }); }}>+ Add a filter</button>
          </fieldset>

          <fieldset className="b-auto">
            <legend>Group and summarise</legend>
            <div className="grid2">
              <label>Group by
                <select value={def.groupBy ?? ''} onChange={(e) => { const g = e.target.value || null; const t = g ? colOf(g)?.type : undefined; patch({ groupBy: g, groupPeriod: t === 'date' || t === 'datetime' ? def.groupPeriod ?? 'month' : null, sort: g ? null : def.sort }); }}>
                  <option value="">No grouping - one row each</option>
                  {options()}
                </select>
              </label>
              {groupCol && (groupCol.type === 'date' || groupCol.type === 'datetime') ? (
                <label>Per
                  <select value={def.groupPeriod ?? 'month'} onChange={(e) => patch({ groupPeriod: e.target.value as Definition['groupPeriod'] })}>
                    <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option><option value="year">Year</option>
                  </select>
                </label>
              ) : !grouped ? (
                <label>Sort by
                  <span style={{ display: 'flex', gap: '.5rem' }}>
                    <select value={def.sort?.ref ?? ''} onChange={(e) => patch({ sort: e.target.value ? { ref: e.target.value, dir: def.sort?.dir ?? 'asc' } : null })}>
                      <option value="">Newest request first</option>
                      {options()}
                    </select>
                    {def.sort && (
                      <select aria-label="Direction" value={def.sort.dir} onChange={(e) => patch({ sort: { ...def.sort!, dir: e.target.value as 'asc' | 'desc' } })} style={{ width: 'auto' }}>
                        <option value="asc">Ascending</option><option value="desc">Descending</option>
                      </select>
                    )}
                  </span>
                </label>
              ) : <span />}
            </div>
            {grouped && <p className="hint">One row per {groupCol?.label ?? 'group'}, with how many {def.lineItems ? 'lines' : 'requests'} it has; choose how each other column is summarised (number columns can be totalled or averaged, other columns are counted).</p>}
          </fieldset>

          <div className="actions">
            <button className="primary" disabled={act.busy || def.columns.length === 0} onClick={() => void runIt()}>{act.busy ? 'Working…' : 'Run report'}</button>
            <button disabled={act.busy || def.columns.length === 0} onClick={() => void exportIt('xlsx')}>Export to Excel</button>
            <button disabled={act.busy || def.columns.length === 0} onClick={() => void exportIt('csv')}>Export to CSV</button>
          </div>
          <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <input aria-label="Report name" placeholder="Name, to save this report" value={current.name} maxLength={200} onChange={(e) => setCurrent({ ...current, name: e.target.value })} style={{ maxWidth: 320 }} />
            <button style={{ width: 'auto' }} disabled={act.busy || !current.name.trim() || def.columns.length === 0} onClick={() => void save(false)}>{current.reportId ? 'Save changes' : 'Save report'}</button>
            {current.reportId && <button style={{ width: 'auto' }} disabled={act.busy || !current.name.trim()} onClick={() => void save(true)}>Save as a new report</button>}
          </div>
        </section>
      )}

      {result && def && (
        <section className="card">
          <h2>Result</h2>
          <p className="muted small">
            {result.records.toLocaleString()} {def.lineItems ? 'line' : 'request'}{result.records === 1 ? '' : 's'}
            {!def.groupBy && result.shownRows < result.records ? `; the first ${result.shownRows.toLocaleString()} are shown - exports have them all` : ''}.
          </p>
          {result.truncated && <p className="notice">Only the newest 20,000 requests were read. Narrow the submitted dates or the status to report on the rest.</p>}
          {def.groupBy && <BarChart result={result} />}
          {result.rows.length === 0 ? <p className="muted">Nothing matches.</p> : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr>{result.columns.map((c) => <th key={c.key} className={c.type === 'number' ? 'num' : undefined}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {result.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={result.columns[j].type === 'number' ? 'num' : undefined}>{show(v, result.columns[j].type)}</td>)}</tr>)}
                  {result.totals && <tr style={{ fontWeight: 600 }}>{result.totals.map((v, j) => <td key={j} className={result.columns[j].type === 'number' ? 'num' : undefined}>{j === 0 && v === null ? 'Total' : show(v, result.columns[j].type)}</td>)}</tr>}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
