// Reports over one form's requests: the values people entered on the form, in each approver's section and in
// data grids, next to the request's own details. Everything is read through tenantQuery, so a report can only
// ever see the organisation it belongs to.
//
// A column is named by a "ref":
//   req.<name>          the request itself: number, status, submitter, dates... (REQUEST_COLUMNS)
//   f.<key>             a control of the submission form
//   s<n>.<key>          a control of the approver section of step n
//   gt.<grid>.<column>  the total of a number column of a data grid, per request
//   g.<column>          a column of the data grid chosen for a line-item report (one row per grid row)
// Values are kept as text in the database (RequestData, StepResponses) and converted here by the control's type.
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { tenantQuery } from '../db/query';
import { AppError } from '../http/errors';
import { EXCEL_DATE, EXCEL_DATETIME, excelDateTime, periodLabel as periodName, usDate, usDateTime } from './dates';

export type ColumnType = 'text' | 'number' | 'date' | 'datetime';
export interface CatalogColumn { ref: string; label: string; type: ColumnType; group: string; retired?: boolean }
export interface CatalogGrid { key: string; label: string; columns: CatalogColumn[] }
export interface Catalog { formId: number; formName: string; columns: CatalogColumn[]; grids: CatalogGrid[] }

type Cell = string | number | null;
type Row = Record<string, Cell>;

export const MAX_REQUESTS = 20_000; // per run: narrow the dates or status to report on more
export const MAX_LINES = 100_000;
export const MAX_SHOWN = 5_000; // rows sent to the screen; exports get them all

const REQUEST_COLUMNS: CatalogColumn[] = [
  { ref: 'req.number', label: 'Request number', type: 'text', group: 'Request' },
  { ref: 'req.status', label: 'Status', type: 'text', group: 'Request' },
  { ref: 'req.submitter', label: 'Submitted by', type: 'text', group: 'Request' },
  { ref: 'req.submitterEmail', label: 'Submitter email', type: 'text', group: 'Request' },
  { ref: 'req.submittedAt', label: 'Submitted', type: 'datetime', group: 'Request' },
  { ref: 'req.closedAt', label: 'Closed', type: 'datetime', group: 'Request' },
  { ref: 'req.currentStep', label: 'Waiting at step', type: 'text', group: 'Request' },
  { ref: 'req.rejectionReason', label: 'Rejection reason', type: 'text', group: 'Request' },
  { ref: 'req.days', label: 'Days to decide', type: 'number', group: 'Request' },
];

const NOT_REPORTED = ['heading', 'paragraph', 'divider', 'image'];
const typeOf = (fieldType: string): ColumnType =>
  ['number', 'currency', 'range', 'calc'].includes(fieldType) ? 'number' : fieldType === 'date' ? 'date' : fieldType === 'datetime' ? 'datetime' : 'text';

interface GridColumnDef { key: string; label: string; type: string }

/** Everything a report on this form can show: the request, every control it has had (retired ones too), each approver section, and its data grids. */
export async function reportCatalog(tenantId: number, formId: number): Promise<Catalog> {
  const [form] = await tenantQuery<{ Name: string }>(tenantId, 'SELECT Name FROM Forms WHERE TenantId = @TenantId AND FormId = @F AND DeletedAt IS NULL', { F: formId });
  if (!form) throw new AppError(404, 'not_found', 'Form not found');

  // every version of every control, current ones first, so each key takes its current label
  const fields = await tenantQuery<{ FieldKey: string; Label: string; FieldType: string; PropsJson: string | null; IsActive: boolean }>(
    tenantId,
    'SELECT FieldKey, Label, FieldType, PropsJson, IsActive FROM FormFields WHERE TenantId = @TenantId AND FormId = @F ORDER BY IsActive DESC, SortOrder, FieldId DESC',
    { F: formId },
  );
  const columns: CatalogColumn[] = [...REQUEST_COLUMNS];
  const grids: CatalogGrid[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.FieldKey) || NOT_REPORTED.includes(f.FieldType)) continue;
    seen.add(f.FieldKey);
    const label = f.IsActive ? f.Label : `${f.Label} (retired)`;
    if (f.FieldType === 'grid') {
      const cols: GridColumnDef[] = f.PropsJson ? JSON.parse(f.PropsJson).columns ?? [] : [];
      for (const c of cols) {
        if (typeOf(c.type) === 'number') columns.push({ ref: `gt.${f.FieldKey}.${c.key}`, label: `${label}: ${c.label} (total)`, type: 'number', group: 'Form', retired: !f.IsActive });
      }
      grids.push({ key: f.FieldKey, label, columns: cols.map((c) => ({ ref: `g.${c.key}`, label: c.label, type: typeOf(c.type), group: label })) });
      continue;
    }
    columns.push({ ref: `f.${f.FieldKey}`, label, type: typeOf(f.FieldType), group: 'Form', retired: !f.IsActive });
  }

  // what approvers filled in under older chain versions (steps no longer have controls); the latest version names the step
  const steps = await tenantQuery<{ StepOrder: number; StepName: string; FieldKey: string; Label: string; FieldType: string; IsCurrent: boolean }>(
    tenantId,
    `SELECT s.StepOrder, s.Name AS StepName, sf.FieldKey, sf.Label, sf.FieldType, c.IsCurrent
       FROM StepFields sf
       JOIN ApprovalSteps s ON s.TenantId = sf.TenantId AND s.StepId = sf.StepId
       JOIN ApprovalChains c ON c.TenantId = s.TenantId AND c.ChainId = s.ChainId
      WHERE sf.TenantId = @TenantId AND c.FormId = @F
      ORDER BY s.StepOrder, c.IsCurrent DESC, c.Version DESC, sf.SortOrder`,
    { F: formId },
  );
  for (const s of steps) {
    const ref = `s${s.StepOrder}.${s.FieldKey}`;
    if (seen.has(ref) || NOT_REPORTED.includes(s.FieldType) || s.FieldType === 'grid') continue;
    seen.add(ref);
    columns.push({ ref, label: `${s.Label}${s.IsCurrent ? '' : ' (retired)'}`, type: typeOf(s.FieldType), group: `Step ${s.StepOrder}: ${s.StepName}`, retired: !s.IsCurrent });
  }
  return { formId, formName: form.Name, columns, grids };
}

// ---------------------------------------------------------------------------------------
// the definition of a report, as the Reports page sends it and as a saved report keeps it
// ---------------------------------------------------------------------------------------
const refSchema = z.string().regex(/^(req\.[a-zA-Z]+|f\.[a-z][a-zA-Z0-9_]*|s\d{1,3}\.[a-z][a-zA-Z0-9_]*|gt\.[a-z][a-zA-Z0-9_]*\.[a-z][a-zA-Z0-9_]*|g\.[a-z][a-zA-Z0-9_]*)$/, 'is not a report column');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');
export const OPS = ['eq', 'ne', 'contains', 'gt', 'ge', 'lt', 'le', 'between', 'empty', 'notEmpty'] as const;
export const AGGS = ['sum', 'avg', 'min', 'max', 'count'] as const;
export const reportDefinition = z.object({
  formId: z.number().int().positive(),
  lineItems: z.string().regex(/^[a-z][a-zA-Z0-9_]*$/).nullable().default(null), // a data grid key: one row per grid row
  columns: z.array(z.object({ ref: refSchema, agg: z.enum(AGGS).optional() })).min(1, 'choose at least one column').max(40),
  filters: z.array(z.object({ ref: refSchema, op: z.enum(OPS), value: z.string().max(200).optional(), value2: z.string().max(200).optional() })).max(20).default([]),
  submittedFrom: isoDate.nullable().default(null),
  submittedTo: isoDate.nullable().default(null),
  statuses: z.array(z.enum(['InProgress', 'Approved', 'Rejected', 'Cancelled'])).max(4).default([]),
  groupBy: refSchema.nullable().default(null),
  groupPeriod: z.enum(['day', 'week', 'month', 'year']).nullable().default(null),
  sort: z.object({ ref: refSchema, dir: z.enum(['asc', 'desc']) }).nullable().default(null),
});
export type ReportDefinition = z.infer<typeof reportDefinition>;

export interface ReportResult {
  columns: { key: string; label: string; type: ColumnType }[];
  rows: Cell[][];
  totals: Cell[] | null;
  records: number; // requests (or grid rows) the report covers, after filtering
  truncated: boolean; // more requests matched than one run reads - narrow the dates or status
  shownRows: number; // rows sent (exports send them all)
}

// ---------------------------------------------------------------------------------------
// running a report
// ---------------------------------------------------------------------------------------
/** A stored value as a report shows it. */
function cellOf(fieldType: string, value: string | null): Cell {
  if (value === null || value === '') return null;
  switch (fieldType) {
    case 'number': case 'currency': case 'range': { const n = Number(value); return Number.isFinite(n) ? n : null; }
    case 'checkbox': return value === 'true' ? 'Yes' : 'No';
    case 'multiselect': try { return (JSON.parse(value) as string[]).join(', '); } catch { return value; }
    case 'sigpad': return 'Signed';
    default: return value;
  }
}

const REQUEST_FILTER = `r.TenantId = @TenantId AND r.FormId = @F
   AND (@From IS NULL OR r.SubmittedAt >= @From) AND (@To IS NULL OR r.SubmittedAt < DATEADD(DAY, 1, CAST(@To AS DATE)))
   AND (@Statuses IS NULL OR r.Status IN (SELECT value FROM OPENJSON(@Statuses)))`;

/** Reads the requests (and the values the report needs) and turns them into one record per request or per grid row. */
async function loadRecords(tenantId: number, def: ReportDefinition, refs: string[]): Promise<{ records: Row[]; truncated: boolean }> {
  const params = {
    F: def.formId,
    From: def.submittedFrom,
    To: def.submittedTo,
    Statuses: def.statuses.length ? JSON.stringify(def.statuses) : null,
  };
  const requests = await tenantQuery<Record<string, any>>(
    tenantId,
    `SELECT TOP (${MAX_REQUESTS + 1}) r.RequestId, r.RequestNumber, r.Status, r.SubmittedAt, r.ClosedAt, r.RejectionReason,
            u.DisplayName, u.Email, cs.StepName AS CurrentStep
       FROM Requests r
       JOIN Users u ON u.TenantId = r.TenantId AND u.UserId = r.SubmitterUserId
       LEFT JOIN RequestSteps cs ON cs.TenantId = r.TenantId AND cs.RequestId = r.RequestId AND cs.Status = 'Active'
      WHERE ${REQUEST_FILTER}
      ORDER BY r.SubmittedAt DESC, r.RequestId DESC`,
    params,
  );
  const truncated = requests.length > MAX_REQUESTS;
  if (truncated) requests.length = MAX_REQUESTS;
  const byId = new Map<number, Row>();
  for (const r of requests) {
    byId.set(r.RequestId, {
      'req.number': r.RequestNumber,
      'req.status': r.Status,
      'req.submitter': r.DisplayName,
      'req.submitterEmail': r.Email,
      'req.submittedAt': r.SubmittedAt ? new Date(r.SubmittedAt).toISOString() : null,
      'req.closedAt': r.ClosedAt ? new Date(r.ClosedAt).toISOString() : null,
      'req.currentStep': r.CurrentStep ?? null,
      'req.rejectionReason': r.RejectionReason ?? null,
      'req.days': r.ClosedAt ? Math.round(((new Date(r.ClosedAt).getTime() - new Date(r.SubmittedAt).getTime()) / 86_400_000) * 10) / 10 : null,
    });
  }

  // the submission's values: only the controls the report uses
  const formKeys = new Set<string>();
  for (const ref of refs) {
    if (ref.startsWith('f.')) formKeys.add(ref.slice(2));
    if (ref.startsWith('gt.')) formKeys.add(ref.split('.')[1]);
  }
  if (def.lineItems) formKeys.add(def.lineItems);
  const grids = new Map<number, Record<string, string>>(); // requestId -> grid key -> stored JSON
  if (formKeys.size && byId.size) {
    const values = await tenantQuery<{ RequestId: number; FieldKey: string; FieldType: string; Value: string | null }>(
      tenantId,
      `SELECT d.RequestId, d.FieldKey, d.FieldType, d.Value FROM RequestData d
         JOIN Requests r ON r.TenantId = d.TenantId AND r.RequestId = d.RequestId
        WHERE ${REQUEST_FILTER} AND d.TenantId = @TenantId AND d.FieldKey IN (SELECT value FROM OPENJSON(@Keys))`,
      { ...params, Keys: JSON.stringify([...formKeys]) },
    );
    for (const v of values) {
      const rec = byId.get(v.RequestId);
      if (!rec) continue;
      if (v.FieldType === 'grid') {
        if (v.Value) grids.set(v.RequestId, { ...grids.get(v.RequestId), [v.FieldKey]: v.Value });
        continue;
      }
      rec[`f.${v.FieldKey}`] = cellOf(v.FieldType, v.Value);
    }
    // per-request totals of grid columns
    for (const ref of refs.filter((r) => r.startsWith('gt.'))) {
      const [, grid, column] = ref.split('.');
      for (const [id, rec] of byId) {
        const json = grids.get(id)?.[grid];
        if (!json) { rec[ref] = null; continue; }
        const cells = (JSON.parse(json).rows as Record<string, string | null>[]).map((r) => r[column]).filter((c): c is string => c !== null && c !== undefined && c !== '');
        rec[ref] = cells.length ? cells.reduce((s, c) => s + Number(c), 0) : null;
      }
    }
  }

  // approver sections: s<order>.<key>
  const stepKeys = new Set(refs.filter((r) => /^s\d/.test(r)).map((r) => r.split('.')[1]));
  if (stepKeys.size && byId.size) {
    const values = await tenantQuery<{ RequestId: number; StepOrder: number; FieldKey: string; FieldType: string; Value: string | null }>(
      tenantId,
      `SELECT rs.RequestId, rs.StepOrder, sr.FieldKey, sr.FieldType, sr.Value FROM StepResponses sr
         JOIN RequestSteps rs ON rs.TenantId = sr.TenantId AND rs.RequestStepId = sr.RequestStepId
         JOIN Requests r ON r.TenantId = rs.TenantId AND r.RequestId = rs.RequestId
        WHERE ${REQUEST_FILTER} AND sr.TenantId = @TenantId AND sr.FieldKey IN (SELECT value FROM OPENJSON(@Keys))`,
      { ...params, Keys: JSON.stringify([...stepKeys]) },
    );
    for (const v of values) {
      const rec = byId.get(v.RequestId);
      if (rec) rec[`s${v.StepOrder}.${v.FieldKey}`] = cellOf(v.FieldType, v.Value);
    }
  }

  if (!def.lineItems) return { records: [...byId.values()], truncated };

  // one record per row of the chosen data grid, carrying its request's columns too
  const lines: Row[] = [];
  for (const [id, rec] of byId) {
    const json = grids.get(id)?.[def.lineItems];
    if (!json) continue;
    const grid = JSON.parse(json) as { columns: GridColumnDef[]; rows: Record<string, string | null>[] };
    for (const r of grid.rows) {
      const line: Row = { ...rec };
      for (const c of grid.columns) line[`g.${c.key}`] = cellOf(c.type === 'calc' ? 'number' : c.type, r[c.key] ?? null);
      lines.push(line);
      if (lines.length > MAX_LINES) throw new AppError(400, 'too_many_rows', `More than ${MAX_LINES} lines match. Narrow the dates or status.`);
    }
  }
  return { records: lines, truncated };
}

const isEmpty = (v: Cell) => v === null || v === '';
const dateKey = (v: Cell) => (typeof v === 'string' ? v.slice(0, 10) : '');

function matches(v: Cell, type: ColumnType, f: ReportDefinition['filters'][number]): boolean {
  if (f.op === 'empty') return isEmpty(v);
  if (f.op === 'notEmpty') return !isEmpty(v);
  const want = (f.value ?? '').trim();
  if (type === 'number') {
    if (isEmpty(v)) return false;
    const n = typeof v === 'number' ? v : Number(v);
    const a = Number(want), b = Number((f.value2 ?? '').trim());
    switch (f.op) {
      case 'eq': return n === a; case 'ne': return n !== a;
      case 'gt': return n > a; case 'ge': return n >= a; case 'lt': return n < a; case 'le': return n <= a;
      case 'between': return n >= a && n <= b;
      case 'contains': return String(v).includes(want);
    }
  }
  if (type === 'date' || type === 'datetime') {
    if (isEmpty(v)) return false;
    const d = dateKey(v), b = (f.value2 ?? '').trim();
    switch (f.op) {
      case 'eq': return d === want; case 'ne': return d !== want;
      case 'gt': return d > want; case 'ge': return d >= want; case 'lt': return d < want; case 'le': return d <= want;
      case 'between': return d >= want && d <= b;
      case 'contains': return String(v).includes(want);
    }
  }
  const s = isEmpty(v) ? '' : String(v).toLowerCase();
  const w = want.toLowerCase();
  switch (f.op) {
    case 'eq': return s === w; case 'ne': return s !== w;
    case 'contains': return s.includes(w);
    case 'gt': return s > w; case 'ge': return s >= w; case 'lt': return s < w; case 'le': return s <= w;
    case 'between': return s >= w && s <= (f.value2 ?? '').trim().toLowerCase();
  }
  return false;
}

/** A date's bucket for grouping: 2026-09-23, 2026-W39, 2026-09 or 2026. */
function period(v: Cell, p: ReportDefinition['groupPeriod']): string {
  const d = dateKey(v);
  if (!d || !p || p === 'day') return d;
  if (p === 'month') return d.slice(0, 7);
  if (p === 'year') return d.slice(0, 4);
  const date = new Date(`${d}T00:00:00Z`);
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7)); // ISO weeks belong to the year of their Thursday
  const week1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday.getTime() - week1.getTime()) / 86_400_000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const compare = (a: Cell, b: Cell) => (isEmpty(a) ? (isEmpty(b) ? 0 : 1) : isEmpty(b) ? -1 : typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true }));
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

function aggregate(values: Cell[], agg: (typeof AGGS)[number]): Cell {
  if (agg === 'count') return values.filter((v) => !isEmpty(v)).length;
  const nums = values.filter((v): v is number => typeof v === 'number');
  if (!nums.length) return null;
  if (agg === 'sum') return round6(nums.reduce((s, n) => s + n, 0));
  if (agg === 'avg') return round6(nums.reduce((s, n) => s + n, 0) / nums.length);
  return agg === 'min' ? Math.min(...nums) : Math.max(...nums);
}

const AGG_LABEL: Record<(typeof AGGS)[number], string> = { sum: 'Total', avg: 'Average', min: 'Lowest', max: 'Highest', count: 'Count' };

export async function runReport(tenantId: number, def: ReportDefinition, opts: { all?: boolean } = {}): Promise<ReportResult> {
  const catalog = await reportCatalog(tenantId, def.formId);
  const known = new Map<string, CatalogColumn>(catalog.columns.map((c) => [c.ref, c]));
  if (def.lineItems) {
    const grid = catalog.grids.find((g) => g.key === def.lineItems);
    if (!grid) throw new AppError(400, 'unknown_grid', 'That data grid is not on this form');
    for (const c of grid.columns) known.set(c.ref, { ...c, group: grid.label });
  }
  const used = [...def.columns.map((c) => c.ref), ...def.filters.map((f) => f.ref), ...(def.groupBy ? [def.groupBy] : []), ...(def.sort ? [def.sort.ref] : [])];
  const unknown = used.find((r) => !known.has(r));
  if (unknown) throw new AppError(400, 'unknown_column', unknown.startsWith('g.') && !def.lineItems ? `"${unknown}" is a data grid column: choose one row per line of that grid` : `This form has no column "${unknown}"`);
  for (const f of def.filters) {
    const t = known.get(f.ref)!.type;
    if (!['empty', 'notEmpty'].includes(f.op) && !(f.value ?? '').trim()) throw new AppError(400, 'filter_value', `Give a value to filter "${known.get(f.ref)!.label}" by`);
    if (t === 'number' && !['empty', 'notEmpty', 'contains'].includes(f.op) && (!Number.isFinite(Number(f.value)) || (f.op === 'between' && !Number.isFinite(Number(f.value2 ?? 'x'))))) {
      throw new AppError(400, 'filter_value', `"${known.get(f.ref)!.label}" is a number: filter it by a number`);
    }
  }

  const { records: all, truncated } = await loadRecords(tenantId, def, used);
  const records = all.filter((r) => def.filters.every((f) => matches(r[f.ref] ?? null, known.get(f.ref)!.type, f)));
  const cols = def.columns.map((c) => known.get(c.ref)!);

  let result: ReportResult;
  if (!def.groupBy) {
    if (def.sort) {
      const s = def.sort;
      records.sort((a, b) => compare(a[s.ref] ?? null, b[s.ref] ?? null) * (s.dir === 'desc' ? -1 : 1));
    }
    const rows = records.map((r) => def.columns.map((c) => r[c.ref] ?? null));
    const totals = cols.some((c) => c.type === 'number') ? cols.map((c, i) => (c.type === 'number' ? aggregate(rows.map((r) => r[i]), 'sum') : null)) : null;
    result = { columns: cols.map((c) => ({ key: c.ref, label: c.label, type: c.type })), rows, totals, records: records.length, truncated, shownRows: rows.length };
  } else {
    const by = known.get(def.groupBy)!;
    const dated = by.type === 'date' || by.type === 'datetime';
    const groups = new Map<string, Row[]>();
    for (const r of records) {
      const v = r[def.groupBy] ?? null;
      const key = isEmpty(v) ? '' : dated ? period(v, def.groupPeriod ?? 'day') : String(v);
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    const aggs = def.columns.filter((c) => c.ref !== def.groupBy).map((c) => ({ ...c, col: known.get(c.ref)!, agg: c.agg ?? (known.get(c.ref)!.type === 'number' ? 'sum' : 'count') }) as const);
    const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { numeric: true })));
    const rows = keys.map((k) => {
      const members = groups.get(k)!;
      return [k === '' ? '(empty)' : dated ? periodName(k) : k, members.length, ...aggs.map((a) => aggregate(members.map((m) => m[a.ref] ?? null), a.agg))];
    });
    const totals: Cell[] = ['Total', records.length, ...aggs.map((a) => aggregate(records.map((m) => m[a.ref] ?? null), a.agg))];
    const periodLabel = dated && def.groupPeriod && def.groupPeriod !== 'day' ? ` (${def.groupPeriod})` : '';
    result = {
      columns: [
        { key: def.groupBy, label: `${by.label}${periodLabel}`, type: 'text' },
        { key: '#count', label: def.lineItems ? 'Lines' : 'Requests', type: 'number' },
        ...aggs.map((a) => ({ key: `${a.agg}:${a.ref}`, label: `${AGG_LABEL[a.agg]} of ${a.col.label}`, type: (a.agg === 'count' || a.col.type === 'number' ? 'number' : a.col.type) as ColumnType })),
      ],
      rows,
      totals,
      records: records.length,
      truncated,
      shownRows: rows.length,
    };
  }
  if (!opts.all && result.rows.length > MAX_SHOWN) {
    result.rows = result.rows.slice(0, MAX_SHOWN);
    result.shownRows = MAX_SHOWN;
  }
  return result;
}

// ---------------------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------------------
/** Spreadsheet apps execute cells starting with = + - @ ; neutralise them, then apply normal CSV quoting. */
export const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** A cell as people read it: dates MM/DD/YYYY, dates with a time MM/DD/YYYY h:mm AM/PM in the reader's time zone. */
const readable = (v: Cell, type: ColumnType, timeZone: string): Cell =>
  typeof v !== 'string' ? v : type === 'date' ? usDate(v) : type === 'datetime' ? usDateTime(v, timeZone) : v;

export function reportCsv(r: ReportResult, timeZone = 'UTC'): string {
  const lines = [r.columns.map((c) => csvCell(c.label)).join(',')];
  const line = (row: Cell[]) => row.map((v, i) => csvCell(readable(v, r.columns[i].type, timeZone))).join(',');
  for (const row of r.rows) lines.push(line(row));
  if (r.totals) lines.push(line(r.totals));
  return `﻿${lines.join('\r\n')}\r\n`; // the BOM makes Excel read it as UTF-8
}

export async function reportXlsx(r: ReportResult, title: string, timeZone = 'UTC'): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report');
  ws.addRow(r.columns.map((c) => c.label)).font = { bold: true };
  const asCell = (v: Cell, type: ColumnType) => {
    if (v === null) return null;
    if (type === 'datetime' && typeof v === 'string') return excelDateTime(v, timeZone);
    if (type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00Z`);
    // text that starts like a formula stays text (Excel would otherwise evaluate it)
    return typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v;
  };
  for (const row of r.rows) ws.addRow(row.map((v, i) => asCell(v, r.columns[i].type)));
  if (r.totals) ws.addRow(r.totals.map((v, i) => asCell(v, r.columns[i].type))).font = { bold: true };
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(50, Math.max(12, c.label.length + 2));
    if (c.type === 'datetime') col.numFmt = EXCEL_DATETIME;
    if (c.type === 'date') col.numFmt = EXCEL_DATE;
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
