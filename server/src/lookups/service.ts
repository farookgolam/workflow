// Lookup tables: reference data imported from Excel (first worksheet, first row = column headings).
// A form's "lookup" control offers the key column's values; other controls can be auto-filled from the
// chosen row. Auto-filled values are ALWAYS computed here on the server at submit time - whatever the
// browser sends for them is ignored - and are then stored with the request like any other answer, so
// later changes to the spreadsheet never alter past requests.
import ExcelJS from 'exceljs';
import { tenantQuery, type Tx } from '../db/query';
import { AppError } from '../http/errors';
import type { FieldDef } from '../forms/validation';

export const LIMITS = { bytes: 5 * 1024 * 1024, rows: 5000, columns: 30, cell: 1000 };

export interface ParsedSheet {
  sheetName: string;
  columns: string[];
  rows: Record<string, string>[];
  warnings: string[];
}

const pad = (n: number) => String(n).padStart(2, '0');
function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const date = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    return v.getUTCHours() || v.getUTCMinutes() ? `${date} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}` : date;
  }
  if (typeof v === 'object') {
    const o = v as unknown as Record<string, unknown>;
    if ('result' in o) return cellText(o.result as ExcelJS.CellValue); // formula: use its calculated value
    if ('richText' in o) return (o.richText as { text: string }[]).map((r) => r.text).join('');
    if ('text' in o) return String(o.text); // hyperlink
    if ('error' in o) return '';
    return '';
  }
  return String(v);
}

/** Reads an .xlsx file into column names + rows of strings. Never trusts the file: size, shape and content are all bounded. */
export async function parseWorkbook(file: Buffer): Promise<ParsedSheet> {
  if (!file?.length) throw new AppError(400, 'empty_file', 'The file is empty.');
  if (file.length > LIMITS.bytes) throw new AppError(413, 'too_large', 'The file is larger than 5 MB.');
  // .xlsx files are zip archives and start with "PK"; this catches .xls, .csv and renamed files with a clear message
  if (file[0] !== 0x50 || file[1] !== 0x4b) throw new AppError(400, 'not_xlsx', 'This is not an Excel .xlsx file. Open it in Excel and use Save As > Excel Workbook (.xlsx).');

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(file as unknown as ArrayBuffer);
  } catch {
    throw new AppError(400, 'not_xlsx', 'The file could not be read as an Excel workbook.');
  }
  const ws = wb.worksheets.find((s) => s.state === 'visible' && s.actualRowCount > 0) ?? wb.worksheets[0];
  if (!ws || ws.actualRowCount === 0) throw new AppError(400, 'empty_sheet', 'The workbook has no data.');

  const warnings: string[] = [];
  if (wb.worksheets.length > 1) warnings.push(`The workbook has ${wb.worksheets.length} sheets; "${ws.name}" was used.`);

  const headerRow = ws.getRow(1);
  const columns: { index: number; name: string }[] = [];
  const seen = new Set<string>();
  for (let c = 1; c <= Math.min(ws.actualColumnCount, 200); c++) {
    const name = cellText(headerRow.getCell(c).value).replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!name) continue;
    if (seen.has(name.toLowerCase())) throw new AppError(400, 'duplicate_column', `Two columns are both called "${name}". Column headings must be different.`);
    seen.add(name.toLowerCase());
    columns.push({ index: c, name });
  }
  if (columns.length === 0) throw new AppError(400, 'no_headings', 'The first row must contain the column headings.');
  if (columns.length > LIMITS.columns) throw new AppError(400, 'too_many_columns', `At most ${LIMITS.columns} columns are supported.`);

  const rows: Record<string, string>[] = [];
  let truncated = 0;
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const record: Record<string, string> = {};
    let any = false;
    for (const col of columns) {
      let text = cellText(row.getCell(col.index).value).trim();
      if (text.length > LIMITS.cell) { text = text.slice(0, LIMITS.cell); truncated++; }
      if (text) any = true;
      record[col.name] = text;
    }
    if (!any) continue; // blank line
    if (rows.length >= LIMITS.rows) throw new AppError(400, 'too_many_rows', `At most ${LIMITS.rows} rows are supported.`);
    rows.push(record);
  }
  if (rows.length === 0) throw new AppError(400, 'no_rows', 'There are no data rows under the headings.');
  if (truncated) warnings.push(`${truncated} cell(s) were longer than ${LIMITS.cell} characters and were shortened.`);
  return { sheetName: ws.name, columns: columns.map((c) => c.name), rows, warnings };
}

/** Key values must be present and unique - they are what the person picks on the form. */
export function checkKeyColumn(sheet: ParsedSheet, keyColumn: string): void {
  if (!sheet.columns.includes(keyColumn)) throw new AppError(400, 'bad_key_column', `There is no column called "${keyColumn}".`);
  const counts = new Map<string, number>();
  let blank = 0;
  for (const r of sheet.rows) {
    const k = r[keyColumn];
    if (!k) blank++;
    else counts.set(k.toLowerCase(), (counts.get(k.toLowerCase()) ?? 0) + 1);
  }
  if (blank) throw new AppError(400, 'blank_keys', `${blank} row(s) have no value in the key column "${keyColumn}".`);
  const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => sheet.rows.find((r) => r[keyColumn].toLowerCase() === k)![keyColumn]);
  if (dupes.length) throw new AppError(400, 'duplicate_keys', `The key column "${keyColumn}" must not repeat a value. Repeated: ${dupes.slice(0, 5).join(', ')}${dupes.length > 5 ? '...' : ''}`);
  if (sheet.rows.some((r) => r[keyColumn].length > 400)) throw new AppError(400, 'key_too_long', 'Key values can be at most 400 characters.');
}

export async function saveRows(tenantId: number, lookupId: number, sheet: ParsedSheet, keyColumn: string, tx: Tx): Promise<void> {
  await tenantQuery(tenantId, 'DELETE FROM LookupRows WHERE TenantId = @TenantId AND LookupId = @L', { L: lookupId }, tx);
  // multi-row inserts keep a 5,000-row import to a handful of round trips
  const CHUNK = 200;
  for (let start = 0; start < sheet.rows.length; start += CHUNK) {
    const params: Record<string, string | number> = { L: lookupId };
    const values = sheet.rows.slice(start, start + CHUNK).map((row, i) => {
      const { [keyColumn]: key, ...rest } = row;
      params[`K${i}`] = key;
      params[`D${i}`] = JSON.stringify(rest);
      params[`S${i}`] = start + i + 1;
      return `(@TenantId, @L, @K${i}, @D${i}, @S${i})`;
    });
    await tenantQuery(tenantId, `INSERT INTO LookupRows (TenantId, LookupId, KeyValue, DataJson, SortOrder) VALUES ${values.join(', ')}`, params, tx);
  }
}

// ---------------------------------------------------------------------------------------
// form integration
// ---------------------------------------------------------------------------------------
const AUTOFILL_TYPES = ['text', 'textarea', 'email', 'tel', 'url', 'number', 'currency'];
type LookupFieldConfig = { key: string; label: string; type: string; required?: boolean; props?: { lookupId?: number; lookupFrom?: string; lookupColumn?: string } | null };

/** Called whenever form fields are saved: every lookup reference must point at something real. */
export async function assertLookupConfig(tenantId: number, fields: LookupFieldConfig[], tx: Tx): Promise<void> {
  const fail = (path: string, message: string) => new AppError(400, 'validation_failed', 'Invalid input', [{ path, message }]);
  const tables = new Map<number, string[]>();
  for (const f of fields.filter((x) => x.type === 'lookup')) {
    const id = f.props?.lookupId;
    if (!id) throw fail(f.key, `${f.label}: choose which lookup table to use`);
    if (tables.has(id)) continue;
    const [t] = await tenantQuery<{ ColumnsJson: string }>(tenantId, 'SELECT ColumnsJson FROM LookupTables WHERE TenantId = @TenantId AND LookupId = @L', { L: id }, tx);
    if (!t) throw fail(f.key, `${f.label}: that lookup table no longer exists`);
    tables.set(id, JSON.parse(t.ColumnsJson));
  }
  for (const f of fields) {
    const p = f.props ?? {};
    if (!p.lookupFrom && !p.lookupColumn) continue;
    if (!AUTOFILL_TYPES.includes(f.type)) throw fail(f.key, `${f.label}: this type of control cannot be filled from a lookup`);
    const source = fields.find((x) => x.key === p.lookupFrom && x.type === 'lookup');
    if (!source) throw fail(f.key, `${f.label}: choose the lookup control it is filled from`);
    const columns = tables.get(source.props!.lookupId!) ?? [];
    if (!p.lookupColumn || !columns.includes(p.lookupColumn)) throw fail(f.key, `${f.label}: the lookup table has no column "${p.lookupColumn ?? ''}"`);
  }
}

export interface LookupRow { key: string; data: Record<string, string> }

/** For validation at submit time: the row each lookup control's submitted key points at (only those rows are read). */
export async function resolveLookupRows(tenantId: number, defs: FieldDef[], input: Record<string, unknown>, tx?: Tx): Promise<Map<string, LookupRow | null>> {
  const out = new Map<string, LookupRow | null>();
  for (const d of defs) {
    if (d.type !== 'lookup') continue;
    const raw = input[d.key];
    if (typeof raw !== 'string' || !raw.trim() || !d.props?.lookupId) { out.set(d.key, null); continue; }
    const [row] = await tenantQuery<{ KeyValue: string; DataJson: string }>(
      tenantId,
      'SELECT KeyValue, DataJson FROM LookupRows WHERE TenantId = @TenantId AND LookupId = @L AND KeyValue = @K',
      { L: d.props.lookupId, K: raw.trim() },
      tx,
    );
    out.set(d.key, row ? { key: row.KeyValue, data: JSON.parse(row.DataJson) } : null);
  }
  return out;
}

/**
 * What the browser needs to render lookup controls and preview the auto-fill: the keys, plus ONLY the
 * columns this set of fields actually uses - a wide spreadsheet is never sent wholesale to submitters.
 */
export async function lookupDataForFields(tenantId: number, defs: FieldDef[], alsoColumns: { fieldKey: string; column: string }[] = []): Promise<Record<number, { rows: LookupRow[] }>> {
  const out: Record<number, { rows: LookupRow[] }> = {};
  for (const d of defs) {
    const id = d.props?.lookupId;
    if (d.type !== 'lookup' || !id || out[id]) continue;
    const used = new Set(defs.filter((x) => x.props?.lookupFrom && defs.find((s) => s.key === x.props!.lookupFrom)?.props?.lookupId === id).map((x) => x.props!.lookupColumn!));
    for (const extra of alsoColumns) if (defs.find((s) => s.key === extra.fieldKey)?.props?.lookupId === id) used.add(extra.column);
    const rows = await tenantQuery<{ KeyValue: string; DataJson: string }>(tenantId, 'SELECT KeyValue, DataJson FROM LookupRows WHERE TenantId = @TenantId AND LookupId = @L ORDER BY SortOrder', { L: id });
    out[id] = {
      rows: rows.map((r) => {
        const all = JSON.parse(r.DataJson) as Record<string, string>;
        return { key: r.KeyValue, data: Object.fromEntries([...used].map((c) => [c, all[c] ?? ''])) };
      }),
    };
  }
  return out;
}

/** Forms (not deleted, current definitions, including the lists their steps choose approvers from) that still use a lookup table - it cannot be removed while any do. */
export async function lookupUsage(tenantId: number, lookupId: number, tx?: Tx): Promise<string[]> {
  const like = `%"lookupId":${lookupId}[,}]%`;
  const rows = await tenantQuery<{ Name: string }>(
    tenantId,
    `SELECT DISTINCT f.Name FROM Forms f
      WHERE f.TenantId = @TenantId AND f.DeletedAt IS NULL AND (
        EXISTS (SELECT 1 FROM FormFields ff WHERE ff.TenantId = f.TenantId AND ff.FormId = f.FormId AND ff.IsActive = 1 AND ff.PropsJson LIKE @Like)
        OR EXISTS (SELECT 1 FROM ApprovalChains c
                     JOIN ApprovalSteps s ON s.TenantId = c.TenantId AND s.ChainId = c.ChainId
                    WHERE c.TenantId = f.TenantId AND c.FormId = f.FormId AND c.IsCurrent = 1 AND s.ApproverListLookupId = @L))`,
    { Like: like, L: lookupId },
    tx,
  );
  return rows.map((r) => r.Name);
}

/** Columns of a lookup table that current form definitions auto-fill from - a replacement file must keep them. */
export async function columnsInUse(tenantId: number, lookupId: number, tx?: Tx): Promise<string[]> {
  const rows = await tenantQuery<{ GroupId: string; FieldKey: string; FieldType: string; PropsJson: string | null }>(
    tenantId,
    `SELECT 'F' + CAST(ff.FormId AS VARCHAR(12)) AS GroupId, ff.FieldKey, ff.FieldType, ff.PropsJson
       FROM FormFields ff JOIN Forms f ON f.TenantId = ff.TenantId AND f.FormId = ff.FormId AND f.DeletedAt IS NULL
      WHERE ff.TenantId = @TenantId AND ff.IsActive = 1 AND ff.PropsJson IS NOT NULL`,
    {},
    tx,
  );
  const groups = new Map<string, { key: string; type: string; props: { lookupId?: number; lookupFrom?: string; lookupColumn?: string } }[]>();
  for (const r of rows) {
    const list = groups.get(r.GroupId) ?? [];
    list.push({ key: r.FieldKey, type: r.FieldType, props: JSON.parse(r.PropsJson ?? '{}') });
    groups.set(r.GroupId, list);
  }
  const used = new Set<string>();
  for (const fields of groups.values()) {
    const sources = new Set(fields.filter((f) => f.type === 'lookup' && f.props.lookupId === lookupId).map((f) => f.key));
    for (const f of fields) {
      if (!f.props.lookupFrom || !f.props.lookupColumn) continue;
      if (sources.has(f.props.lookupFrom)) used.add(f.props.lookupColumn);
    }
  }
  // columns of a table that lists a step's approvers: their email, and whatever is shown beside the chosen person
  const lists = await tenantQuery<{ ApproverListEmailColumn: string | null; ApproverListNameColumn: string | null; ApproverListColumnsJson: string | null }>(
    tenantId,
    `SELECT s.ApproverListEmailColumn, s.ApproverListNameColumn, s.ApproverListColumnsJson
       FROM ApprovalSteps s
       JOIN ApprovalChains c ON c.TenantId = s.TenantId AND c.ChainId = s.ChainId AND c.IsCurrent = 1
       JOIN Forms f ON f.TenantId = c.TenantId AND f.FormId = c.FormId AND f.DeletedAt IS NULL
      WHERE s.TenantId = @TenantId AND s.ApproverListLookupId = @L`,
    { L: lookupId },
    tx,
  );
  const [self] = await tenantQuery<{ KeyColumn: string }>(tenantId, 'SELECT KeyColumn FROM LookupTables WHERE TenantId = @TenantId AND LookupId = @L', { L: lookupId }, tx);
  for (const l of lists) for (const c of [l.ApproverListEmailColumn, l.ApproverListNameColumn, ...(JSON.parse(l.ApproverListColumnsJson ?? '[]') as string[])]) if (c && c !== self?.KeyColumn) used.add(c);
  return [...used];
}
