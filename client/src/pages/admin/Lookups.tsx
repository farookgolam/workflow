// Lookup tables: import an Excel sheet once, then use it in any form - a "Lookup" control offers the key
// column's values and other controls can be auto-filled from the chosen row.
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, uploadFile } from '../../api';
import { fmtDateTime } from '../../fields';
import { useAction, useLoad } from '../../hooks';

interface LookupTable { lookupId: number; name: string; keyColumn: string; columns: string[]; rows: number; sourceFileName: string | null; updatedAt: string; usedBy: string[] }
interface Preview { sheetName: string; columns: string[]; rowCount: number; sample: Record<string, string>[]; warnings: string[] }
interface Detail { lookupId: number; name: string; keyColumn: string; columns: string[]; rows: number; matches: number; sample: Record<string, string>[]; rowIds: number[] }

const isXlsx = (f: File) => /\.xlsx$/i.test(f.name);

/** One box per column, key column first. The server applies the import's rules (key required and unique). */
function AddRow({ table, onAdded }: { table: Detail; onAdded(row: Record<string, string>): Promise<void> }) {
  const act = useAction();
  const columns = [table.keyColumn, ...table.columns.filter((c) => c !== table.keyColumn)];
  const [values, setValues] = useState<Record<string, string>>({});
  const add = () =>
    act.run(async () => {
      const { row } = await api<{ row: Record<string, string> }>(`/admin/lookups/${table.lookupId}/rows`, { method: 'POST', body: { values } });
      setValues({});
      await onAdded(row);
      return `"${row[table.keyColumn]}" was added at the end of the table. Forms that use this table offer it straight away.`;
    });

  return (
    <form className="stack" style={{ marginTop: '1rem' }} onSubmit={(e) => { e.preventDefault(); void add(); }}>
      <h3 style={{ margin: 0 }}>Add a row</h3>
      {act.error && <p className="notice bad" role="alert">{act.error}</p>}
      {act.ok && <p className="notice ok" role="status">{act.ok}</p>}
      <div className="grid2">
        {columns.map((c) => (
          <label key={c}><span>{c}{c === table.keyColumn && <em className="req"> *</em>}</span>
            <input aria-label={c} value={values[c] ?? ''} maxLength={c === table.keyColumn ? 400 : 1000} onChange={(e) => setValues((v) => ({ ...v, [c]: e.target.value }))} />
          </label>
        ))}
      </div>
      <p className="hint" style={{ margin: 0 }}>{table.keyColumn} is the key: it must be filled in and be different from every other row. The other columns can be left empty.</p>
      <div className="actions">
        <button type="submit" className="primary" disabled={act.busy || !(values[table.keyColumn] ?? '').trim()}>{act.busy ? 'Adding…' : 'Add row'}</button>
      </div>
    </form>
  );
}

/** An opened table: find rows, change or delete one in place, add a new one. */
function LookupView({ lookupId, onChanged, onClose }: { lookupId: number; onChanged(): void; onClose(): void }) {
  const act = useAction();
  const [table, setTable] = useState<Detail | null>(null);
  const [search, setSearch] = useState('');
  const [shownFor, setShownFor] = useState('');
  const [editing, setEditing] = useState<{ rowId: number; values: Record<string, string> } | null>(null);
  const [deleting, setDeleting] = useState<number | null>(null);

  const load = async (q = shownFor) => {
    setTable(await api<Detail>(`/admin/lookups/${lookupId}${q ? `?${new URLSearchParams({ q })}` : ''}`));
    setShownFor(q);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void act.run(() => load('')); }, [lookupId]);

  if (!table) return <section className="card">{act.error ? <p className="notice bad">{act.error}</p> : <p className="muted">Loading…</p>}</section>;
  const columns = [table.keyColumn, ...table.columns.filter((c) => c !== table.keyColumn)];
  const keyOf = (rowId: number) => table.sample[table.rowIds.indexOf(rowId)]?.[table.keyColumn] ?? '';

  const save = () =>
    act.run(async () => {
      const { row } = await api<{ row: Record<string, string> }>(`/admin/lookups/${lookupId}/rows/${editing!.rowId}`, { method: 'PUT', body: { values: editing!.values } });
      setEditing(null);
      await load();
      onChanged();
      return `"${row[table.keyColumn]}" was saved. Forms offer the new values from now on; requests already submitted keep theirs.`;
    });
  const remove = (rowId: number) =>
    act.run(async () => {
      const key = keyOf(rowId);
      await api(`/admin/lookups/${lookupId}/rows/${rowId}`, { method: 'DELETE' });
      setDeleting(null);
      await load();
      onChanged();
      return `"${key}" was deleted. Forms no longer offer it; requests already submitted keep their values.`;
    });

  return (
    <section className="card">
      <div className="prev-head"><h2 style={{ margin: 0 }}>{table.name}</h2><button className="link" onClick={onClose}>Close</button></div>
      {act.error && <p className="notice bad" role="alert">{act.error}</p>}
      {act.ok && <p className="notice ok" role="status">{act.ok}</p>}
      <form style={{ display: 'flex', gap: '.5rem', alignItems: 'center', margin: '.6rem 0' }} onSubmit={(e) => { e.preventDefault(); setEditing(null); setDeleting(null); void act.run(() => load(search.trim())); }}>
        <input type="search" aria-label="Find a row" placeholder="Find a row - type any part of any cell" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1 }} />
        <button type="submit" disabled={act.busy} style={{ width: 'auto' }}>Find</button>
        {shownFor && <button type="button" className="link" onClick={() => { setSearch(''); void act.run(() => load('')); }}>Show all</button>}
      </form>
      <p className="muted small">
        {shownFor ? `${table.matches} of ${table.rows} row(s) contain "${shownFor}"` : `${table.rows} row(s)`}
        {table.matches > table.sample.length && `, first ${table.sample.length} shown - use Find to reach the others`}.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="sample-table">
          <thead><tr>{columns.map((c) => <th key={c} className={c === table.keyColumn ? 'key' : ''}>{c}{c === table.keyColumn && ' (key)'}</th>)}<th /></tr></thead>
          <tbody>
            {table.sample.map((r, i) => {
              const rowId = table.rowIds[i];
              if (editing?.rowId === rowId) {
                return (
                  <tr key={rowId}>
                    {columns.map((c) => (
                      <td key={c}><input aria-label={c} value={editing.values[c] ?? ''} maxLength={c === table.keyColumn ? 400 : 1000}
                        onChange={(e) => setEditing({ rowId, values: { ...editing.values, [c]: e.target.value } })}
                        onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEditing(null); }} /></td>
                    ))}
                    <td className="row-actions">
                      <button className="link" disabled={act.busy || !(editing.values[table.keyColumn] ?? '').trim()} onClick={() => void save()}>Save</button>
                      <button className="link" onClick={() => setEditing(null)}>Cancel</button>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={rowId}>
                  {columns.map((c) => <td key={c}>{r[c]}</td>)}
                  <td className="row-actions">
                    {deleting === rowId ? (
                      <>
                        <span className="small">Delete this row?</span>
                        <button className="link danger-link" disabled={act.busy} onClick={() => void remove(rowId)}>Yes, delete</button>
                        <button className="link" onClick={() => setDeleting(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button className="link" disabled={act.busy} onClick={() => { act.clear(); setDeleting(null); setEditing({ rowId, values: Object.fromEntries(columns.map((c) => [c, r[c] ?? ''])) }); }}>Edit</button>
                        <button className="link danger-link" disabled={act.busy} onClick={() => { act.clear(); setEditing(null); setDeleting(rowId); }}>Delete</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {table.sample.length === 0 && <tr><td colSpan={columns.length + 1} className="muted">{shownFor ? 'No row contains that text.' : 'This table has no rows.'}</td></tr>}
          </tbody>
        </table>
      </div>
      <AddRow key={table.lookupId} table={table} onAdded={async () => { await load(); onChanged(); }} />
      <p className="hint">Changes here apply to new requests at once. Requests already submitted keep the values they were given. Rows you add, change or delete here are not in your spreadsheet: <strong>Replace data</strong> puts the whole table back to what the file contains.</p>
    </section>
  );
}

function SampleTable({ columns, rows, keyColumn }: { columns: string[]; rows: Record<string, string>[]; keyColumn?: string }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="sample-table">
        <thead><tr>{columns.map((c) => <th key={c} className={c === keyColumn ? 'key' : ''}>{c}{c === keyColumn && ' (key)'}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{columns.map((c) => <td key={c}>{r[c]}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function AdminLookups() {
  const { data, error, reload } = useLoad<{ lookups: LookupTable[] }>('/admin/lookups');
  const act = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState('');
  const [keyColumn, setKeyColumn] = useState('');
  const [viewing, setViewing] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<LookupTable | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<LookupTable | null>(null);

  const choose = (f: File | undefined) => {
    if (!f) return;
    act.clear();
    void act.run(async () => {
      if (!isXlsx(f)) throw new ApiError(400, 'not_xlsx', 'Choose an Excel .xlsx file. (Older .xls or .csv files: open them in Excel and use Save As > Excel Workbook.)');
      const p = await uploadFile<Preview>('/admin/lookups/parse', f);
      setFile(f);
      setPreview(p);
      setName(f.name.replace(/\.xlsx$/i, '').replace(/[_-]+/g, ' ').trim());
      setKeyColumn(p.columns[0]);
    });
  };
  const doImport = () =>
    act.run(async () => {
      const q = new URLSearchParams({ name: name.trim(), keyColumn, fileName: file!.name });
      const r = await uploadFile<{ rows: number }>(`/admin/lookups/import?${q}`, file!);
      setPreview(null); setFile(null);
      reload();
      return `"${name.trim()}" imported with ${r.rows} row(s). Open a form, add a Lookup (Excel) control and choose this table.`;
    });
  const doReplace = (f: File | undefined) => {
    const t = replaceTarget.current;
    if (!f || !t) return;
    void act.run(async () => {
      if (!isXlsx(f)) throw new ApiError(400, 'not_xlsx', 'Choose an Excel .xlsx file.');
      const r = await uploadFile<{ rows: number }>(`/admin/lookups/${t.lookupId}/import?${new URLSearchParams({ fileName: f.name })}`, f, 'PUT');
      reload();
      setViewing(null);
      return `"${t.name}" now has ${r.rows} row(s). New requests use the new data; requests already submitted keep the values they had.`;
    });
  };
  const doDelete = (t: LookupTable) =>
    act.run(async () => {
      await api(`/admin/lookups/${t.lookupId}`, { method: 'DELETE' });
      setDeleting(null);
      reload();
      return `"${t.name}" was deleted.`;
    });

  return (
    <div className="stack">
      <h1>Lookup tables</h1>
      {act.error && <p className="notice bad" role="alert">{act.error}</p>}
      {act.ok && <p className="notice ok" role="status">{act.ok}</p>}
      <input ref={replaceInput} type="file" accept=".xlsx" hidden onChange={(e) => { doReplace(e.target.files?.[0]); e.target.value = ''; }} />

      <section className="card">
        {error ? <p className="notice bad">{error}</p> : !data ? <p className="muted">Loading…</p> : data.lookups.length === 0 ? <p className="muted">No lookup tables yet. Import an Excel file below.</p> : (
          <table>
            <thead><tr><th>Name</th><th>Key column</th><th>Other columns</th><th className="num">Rows</th><th>Used by</th><th>Updated</th><th /></tr></thead>
            <tbody>{data.lookups.map((t) => (
              <tr key={t.lookupId}>
                <td><button className="link" onClick={() => { act.clear(); setViewing(t.lookupId); }}>{t.name}</button></td>
                <td>{t.keyColumn}</td>
                <td>{t.columns.filter((c) => c !== t.keyColumn).join(', ') || '—'}</td>
                <td className="num">{t.rows}</td>
                <td>{t.usedBy.join(', ') || <span className="muted">not used</span>}</td>
                <td>{fmtDateTime(t.updatedAt)}</td>
                <td className="row-actions">
                  <button className="link" disabled={act.busy} onClick={() => { replaceTarget.current = t; replaceInput.current?.click(); }}>Replace data</button>
                  <button className="link danger-link" disabled={act.busy} onClick={() => { act.clear(); setDeleting(t); }}>Delete</button>
                </td>
              </tr>))}
            </tbody>
          </table>
        )}
      </section>

      {viewing !== null && <LookupView key={viewing} lookupId={viewing} onChanged={reload} onClose={() => setViewing(null)} />}

      {deleting && (
        <section className="card reject-box" role="alertdialog" aria-labelledby="ldel">
          <h2 id="ldel">Delete "{deleting.name}"?</h2>
          {deleting.usedBy.length > 0
            ? <p>This table is used by <strong>{deleting.usedBy.join(', ')}</strong>. Remove the lookup control from {deleting.usedBy.length === 1 ? 'that form' : 'those forms'} first.</p>
            : <p>The table and its {deleting.rows} row(s) will be deleted. Requests already submitted are not affected - they keep the values they were given.</p>}
          <div className="actions">
            <button className="danger" disabled={act.busy || deleting.usedBy.length > 0} onClick={() => void doDelete(deleting)}>Delete table</button>
            <button onClick={() => setDeleting(null)}>Cancel</button>
          </div>
        </section>
      )}

      {preview ? (
        <section className="card card-active">
          <h2>Import "{file?.name}"</h2>
          <p className="muted">Sheet "{preview.sheetName}" · {preview.rowCount} row(s) · {preview.columns.length} column(s). Nothing is saved yet.</p>
          {preview.warnings.map((w) => <p key={w} className="notice">{w}</p>)}
          <div className="grid2">
            <label>Name of the lookup table<input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></label>
            <label>Key column (what people choose on the form)
              <select value={keyColumn} onChange={(e) => setKeyColumn(e.target.value)}>{preview.columns.map((c) => <option key={c}>{c}</option>)}</select>
            </label>
          </div>
          <p className="hint">Every row needs a different value in the key column. The other columns can fill in other controls automatically.</p>
          <p className="small muted" style={{ margin: '1rem 0 .4rem' }}>First rows</p>
          <SampleTable columns={preview.columns} rows={preview.sample} keyColumn={keyColumn} />
          <div className="actions" style={{ marginTop: '1rem' }}>
            <button className="primary" disabled={act.busy || !name.trim()} onClick={() => void doImport()}>{act.busy ? 'Importing…' : 'Import lookup table'}</button>
            <button disabled={act.busy} onClick={() => { setPreview(null); setFile(null); }}>Discard</button>
          </div>
        </section>
      ) : (
        <section className="card">
          <h2>Import an Excel file</h2>
          <p className="muted">Use the first row for column headings and one row per item - for example <em>School, Department, Secretary, Email</em>. Up to 5,000 rows, 30 columns, 5 MB. The first visible sheet is used.</p>
          <label className="file-btn">
            <input type="file" accept=".xlsx" disabled={act.busy} onChange={(e) => { choose(e.target.files?.[0]); e.target.value = ''; }} />
            <span>{act.busy ? 'Reading…' : 'Choose .xlsx file…'}</span>
          </label>
        </section>
      )}
    </div>
  );
}
