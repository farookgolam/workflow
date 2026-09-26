// The Hours report: the lines of a timesheet form's data grid - Date, School, Time In, Time Out, Worked Hour - for one
// submitter or for everyone, over one day or a range of days WORKED (the grid's own date, not the day the timesheet
// was submitted). With everyone, lines are grouped by person with a subtotal each and a grand total.
//
// Timesheet forms name their grid columns differently, so a report says which column plays which part (`mapping`);
// the server guesses it from the headings and types, and the page lets the administrator correct it.
// Worked hours are the value the form stored; where that is missing or negative (a shift past midnight under an
// older "timeOut - timeIn" formula) they are worked out from Time In and Time Out as elapsed time instead.
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { tenantQuery } from '../db/query';
import { AppError } from '../http/errors';
import { EXCEL_DATE, usDate } from './dates';
import { MAX_REQUESTS, csvCell } from './engine';

interface GridColumn { key: string; label: string; type: string }
export interface HoursMapping { date: string; school: string | null; timeIn: string | null; timeOut: string | null; worked: string | null }
export interface HoursForm { formId: number; name: string; grid: string; gridLabel: string; columns: GridColumn[]; mapping: HoursMapping }

const TIMEISH = ['time'];
const NUMBERISH = ['number', 'currency', 'calc'];

/** Which grid column plays which part, from the headings first and the types second. */
export function guessMapping(cols: GridColumn[]): HoursMapping | null {
  const pick = (types: string[], re: RegExp | null, not: (string | null)[] = []) => {
    const ok = cols.filter((c) => types.includes(c.type) && !not.includes(c.key));
    return (re && ok.find((c) => re.test(c.label))) || ok[0] || null;
  };
  const date = pick(['date'], /date|day/i);
  if (!date) return null;
  const timeIn = pick(TIMEISH, /\bin\b|start|from|arriv/i);
  const timeOut = pick(TIMEISH, /\bout\b|end|finish|to\b|leav|depart/i, [timeIn?.key ?? null]);
  const worked = pick(NUMBERISH, /work|hour|total|duration/i);
  const school = pick(['text', 'select'], /school|site|location|place/i);
  return { date: date.key, school: school?.key ?? null, timeIn: timeIn?.key ?? null, timeOut: timeOut?.key ?? null, worked: worked?.key ?? null };
}

/** Forms this report works on: a data grid with a date column and either two time columns or a worked-hours column. */
export async function hoursForms(tenantId: number): Promise<HoursForm[]> {
  const rows = await tenantQuery<{ FormId: number; Name: string; FieldKey: string; Label: string; PropsJson: string | null }>(
    tenantId,
    `SELECT f.FormId, f.Name, ff.FieldKey, ff.Label, ff.PropsJson
       FROM Forms f JOIN FormFields ff ON ff.TenantId = f.TenantId AND ff.FormId = f.FormId AND ff.IsActive = 1 AND ff.FieldType = 'grid'
      WHERE f.TenantId = @TenantId AND f.DeletedAt IS NULL
      ORDER BY f.Name, ff.SortOrder`,
  );
  const out: HoursForm[] = [];
  for (const r of rows) {
    if (out.some((f) => f.formId === r.FormId)) continue; // one timesheet grid per form: the first that fits
    const columns = ((r.PropsJson ? JSON.parse(r.PropsJson).columns : null) ?? []) as GridColumn[];
    const mapping = guessMapping(columns);
    if (!mapping || (!(mapping.timeIn && mapping.timeOut) && !mapping.worked)) continue;
    out.push({ formId: r.FormId, name: r.Name, grid: r.FieldKey, gridLabel: r.Label, columns: columns.map((c) => ({ key: c.key, label: c.label, type: c.type })), mapping });
  }
  return out;
}

/** Everyone who has submitted this form, for the submitter drop-down. */
export async function hoursSubmitters(tenantId: number, formId: number) {
  const rows = await tenantQuery<{ UserId: number; DisplayName: string; Email: string }>(
    tenantId,
    `SELECT u.UserId, u.DisplayName, u.Email FROM Users u
      WHERE u.TenantId = @TenantId AND EXISTS (SELECT 1 FROM Requests r WHERE r.TenantId = u.TenantId AND r.FormId = @F AND r.SubmitterUserId = u.UserId)
      ORDER BY u.DisplayName, u.UserId`,
    { F: formId },
  );
  return rows.map((u) => ({ userId: u.UserId, displayName: u.DisplayName, email: u.Email }));
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');
const colKey = z.string().regex(/^[a-z][a-zA-Z0-9_]*$/);
export const hoursQuery = z.object({
  formId: z.number().int().positive(),
  mapping: z.object({ date: colKey, school: colKey.nullable().default(null), timeIn: colKey.nullable().default(null), timeOut: colKey.nullable().default(null), worked: colKey.nullable().default(null) }).optional(),
  submitterUserId: z.number().int().positive().nullable().default(null), // null: everyone
  from: isoDate,
  to: isoDate.nullable().default(null), // null: the single day `from`
  includeInProgress: z.boolean().default(false), // approved only unless asked; rejected and cancelled never count
}).refine((q) => !q.to || q.to >= q.from, { message: 'The end date is before the start date', path: ['to'] });
export type HoursQuery = z.infer<typeof hoursQuery>;

type Cell = string | number | null;
export interface HoursLine { kind: 'line' | 'subtotal' | 'total'; submitter: string; date: string | null; school: string | null; timeIn: string | null; timeOut: string | null; hours: number | null; requestNumber: string | null; days?: number }
export interface HoursResult {
  form: string; from: string; to: string; submitter: string | null; includeInProgress: boolean;
  lines: HoursLine[]; // lines, then (for everyone) a subtotal after each person, then the total
  totalHours: number; lineCount: number; people: number; truncated: boolean;
}

const minutes = (t: string | null) => { const m = /^(\d{1,2}):(\d{2})/.exec(t ?? ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Hours between two times of day; a Time Out earlier than the Time In is on the next day. */
export function elapsedHours(timeIn: string | null, timeOut: string | null): number | null {
  const a = minutes(timeIn), b = minutes(timeOut);
  if (a === null || b === null) return null;
  return round2((b >= a ? b - a : b + 24 * 60 - a) / 60);
}

export async function runHours(tenantId: number, q: HoursQuery): Promise<HoursResult> {
  const form = (await hoursForms(tenantId)).find((f) => f.formId === q.formId);
  if (!form) throw new AppError(404, 'not_found', 'That form has no timesheet grid (a date column and time or hours columns)');
  const map = q.mapping ?? form.mapping;
  const typeOf = (k: string | null) => form.columns.find((c) => c.key === k)?.type;
  const bad = (m: string) => new AppError(400, 'validation_failed', 'Invalid input', [{ path: 'mapping', message: m }]);
  if (typeOf(map.date) !== 'date') throw bad('Choose a date column for Date');
  for (const [k, types, label] of [[map.timeIn, TIMEISH, 'Time In'], [map.timeOut, TIMEISH, 'Time Out'], [map.worked, NUMBERISH, 'Worked Hour'], [map.school, null, 'School']] as const) {
    if (k && (!typeOf(k) || (types && !types.includes(typeOf(k)!)))) throw bad(`The column chosen for ${label} is not on this form's grid, or is the wrong type`);
  }
  if (!(map.timeIn && map.timeOut) && !map.worked) throw bad('Choose Time In and Time Out, or a Worked Hour column');
  const to = q.to ?? q.from;

  const requests = await tenantQuery<{ RequestId: number; RequestNumber: string; UserId: number; DisplayName: string; Value: string | null }>(
    tenantId,
    `SELECT TOP (${MAX_REQUESTS + 1}) r.RequestId, r.RequestNumber, u.UserId, u.DisplayName, d.Value
       FROM Requests r
       JOIN Users u ON u.TenantId = r.TenantId AND u.UserId = r.SubmitterUserId
       JOIN RequestData d ON d.TenantId = r.TenantId AND d.RequestId = r.RequestId AND d.FieldKey = @Grid
      WHERE r.TenantId = @TenantId AND r.FormId = @F
        AND r.Status IN (SELECT value FROM OPENJSON(@Statuses))
        AND (@U IS NULL OR r.SubmitterUserId = @U)
      ORDER BY r.SubmittedAt DESC, r.RequestId DESC`,
    { F: q.formId, Grid: form.grid, U: q.submitterUserId, Statuses: JSON.stringify(q.includeInProgress ? ['Approved', 'InProgress'] : ['Approved']) },
  );
  const truncated = requests.length > MAX_REQUESTS;
  if (truncated) requests.length = MAX_REQUESTS;

  const text = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
  const byPerson = new Map<number, { name: string; lines: HoursLine[] }>();
  for (const r of requests) {
    if (!r.Value) continue;
    const rows = (JSON.parse(r.Value).rows ?? []) as Record<string, unknown>[];
    for (const row of rows) {
      const date = text(row[map.date])?.slice(0, 10) ?? null;
      if (!date || date < q.from || date > to) continue;
      const timeIn = map.timeIn ? text(row[map.timeIn]) : null;
      const timeOut = map.timeOut ? text(row[map.timeOut]) : null;
      const stored = map.worked ? Number(text(row[map.worked]) ?? NaN) : NaN;
      const hours = Number.isFinite(stored) && stored >= 0 ? round2(stored) : elapsedHours(timeIn, timeOut);
      const person = byPerson.get(r.UserId) ?? { name: r.DisplayName, lines: [] };
      person.lines.push({ kind: 'line', submitter: r.DisplayName, date, school: map.school ? text(row[map.school]) : null, timeIn, timeOut, hours, requestNumber: r.RequestNumber });
      byPerson.set(r.UserId, person);
    }
  }

  const sum = (ls: HoursLine[]) => round2(ls.reduce((s, l) => s + (l.hours ?? 0), 0));
  const days = (ls: HoursLine[]) => new Set(ls.map((l) => l.date)).size;
  const byTime = (a: HoursLine, b: HoursLine) => (a.date ?? '').localeCompare(b.date ?? '') || (minutes(a.timeIn) ?? 0) - (minutes(b.timeIn) ?? 0);
  const people = [...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name));
  const lines: HoursLine[] = [];
  const all: HoursLine[] = [];
  for (const p of people) {
    p.lines.sort(byTime);
    lines.push(...p.lines);
    all.push(...p.lines);
    if (!q.submitterUserId) lines.push({ kind: 'subtotal', submitter: p.name, date: null, school: null, timeIn: null, timeOut: null, hours: sum(p.lines), requestNumber: null, days: days(p.lines) });
  }
  lines.push({ kind: 'total', submitter: '', date: null, school: null, timeIn: null, timeOut: null, hours: sum(all), requestNumber: null, days: days(all) });

  const submitter = q.submitterUserId ? (await hoursSubmitters(tenantId, q.formId)).find((u) => u.userId === q.submitterUserId)?.displayName ?? 'Unknown' : null;
  return { form: form.name, from: q.from, to, submitter, includeInProgress: q.includeInProgress, lines, totalHours: sum(all), lineCount: all.length, people: people.length, truncated };
}

// ---------------------------------------------------------------------------------------
// exports
// ---------------------------------------------------------------------------------------
export const hoursTitle = (r: HoursResult) => `Hours - ${r.submitter ?? 'All submitters'} - ${r.from === r.to ? usDate(r.from) : `${usDate(r.from)} to ${usDate(r.to)}`}`;
const headings = (r: HoursResult) => [...(r.submitter ? [] : ['Submitter']), 'Date', 'School', 'Time In', 'Time Out', 'Worked Hour', 'Request'];
const cells = (r: HoursResult, l: HoursLine): Cell[] => {
  const label = l.kind === 'total' ? 'Total' : l.kind === 'subtotal' ? `Subtotal - ${l.submitter}` : null;
  const lead: Cell[] = r.submitter ? [] : [label ?? l.submitter];
  if (label) return [...lead, r.submitter ? label : `${l.days} day(s)`, null, null, null, l.hours, null];
  return [...lead, l.date, l.school, l.timeIn, l.timeOut, l.hours, l.requestNumber]; // dates stay ISO here: CSV and Excel format them
};

export function hoursCsv(r: HoursResult): string {
  const out = [headings(r).map(csvCell).join(',')];
  const dateCol = headings(r).indexOf('Date');
  for (const l of r.lines) out.push(cells(r, l).map((v, i) => csvCell(i === dateCol && typeof v === 'string' ? usDate(v) : v)).join(','));
  return `﻿${out.join('\r\n')}\r\n`; // the BOM makes Excel read it as UTF-8
}

export async function hoursXlsx(r: HoursResult): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Hours');
  ws.addRow([`${r.form}: ${hoursTitle(r)}`]).font = { bold: true, size: 13 };
  ws.addRow([`${r.includeInProgress ? 'Approved and in-progress' : 'Approved'} timesheets · ${r.lineCount} line(s) · ${r.people} person(s) · ${r.totalHours} hours`]);
  ws.addRow([]);
  const head = headings(r);
  ws.addRow(head).font = { bold: true };
  const dateCol = head.indexOf('Date');
  for (const l of r.lines) {
    const row = cells(r, l).map((v, i) => (i === dateCol && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v));
    const added = ws.addRow(row);
    if (l.kind !== 'line') added.font = { bold: true };
  }
  head.forEach((h, i) => {
    const col = ws.getColumn(i + 1);
    col.width = h === 'Submitter' || h === 'School' ? 30 : 14;
    if (h === 'Date') col.numFmt = EXCEL_DATE;
    if (h === 'Worked Hour') col.numFmt = '0.00';
  });
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
