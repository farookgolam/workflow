// Bulk export of a customer's PDFs: one form, a range of submitted dates, approved and/or rejected. One ZIP holding
// every PDF (named as archived: archiveFileName) and Index.xlsx - one row per PDF with the request's details, its
// approval steps and the form's own fields, the file name linking to the PDF next to it. Used by the customer's
// administrators (/admin/exports) and by global administrators for any customer (/global/tenants/:id/exports).
import archiver from 'archiver';
import ExcelJS from 'exceljs';
import type { Writable } from 'node:stream';
import { z } from 'zod';
import { tenantQuery } from '../db/query';
import { AppError } from '../http/errors';
import { usDate } from '../reports/dates';
import { loadRequestDetail, type FieldValue } from '../workflow/read';
import { archiveFileName, fileFormPart } from './pdf';
import { loadDocument } from './worker';

export const MAX_EXPORT = 500;

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-01');
export const exportQuery = z.object({
  formId: z.coerce.number().int().positive().max(2147483647),
  from: day,
  to: day,
  status: z.enum(['Approved', 'Rejected', 'Both']).default('Both'),
}).refine((q) => q.from <= q.to, { message: 'The From date must not be after the To date', path: ['to'] });
export type ExportQuery = z.infer<typeof exportQuery>;

/** Midnight at the start of a day, and of the day after it, in server time - the same days as the file names. */
const startOf = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd); };
const ddmmyyyy = (d: string) => `${d.slice(8, 10)}${d.slice(5, 7)}${d.slice(0, 4)}`;

/** Requests of the form, submitted in the range, closed with that outcome - with whether their PDF is there yet. */
async function matching(tenantId: number, q: ExportQuery) {
  const until = startOf(q.to); until.setDate(until.getDate() + 1);
  return tenantQuery<{ RequestId: number; HasPdf: number }>(
    tenantId,
    `SELECT r.RequestId,
            CASE WHEN EXISTS (SELECT 1 FROM RequestDocuments d WHERE d.TenantId = r.TenantId AND d.RequestId = r.RequestId) OR r.PdfLocalPath IS NOT NULL
                 THEN 1 ELSE 0 END AS HasPdf
       FROM Requests r
      WHERE r.TenantId = @TenantId AND r.FormId = @FormId
        AND r.Status IN (SELECT value FROM OPENJSON(@Statuses))
        AND r.SubmittedAt >= @From AND r.SubmittedAt < @Until
      ORDER BY r.SubmittedAt, r.RequestId`,
    { FormId: q.formId, Statuses: JSON.stringify(q.status === 'Both' ? ['Approved', 'Rejected'] : [q.status]), From: startOf(q.from), Until: until },
  );
}

async function formName(tenantId: number, formId: number): Promise<string> {
  const [f] = await tenantQuery<{ Name: string }>(tenantId, 'SELECT Name FROM Forms WHERE TenantId = @TenantId AND FormId = @FormId', { FormId: formId });
  if (!f) throw new AppError(404, 'not_found', 'Form not found');
  return f.Name;
}

/** What the export would hold - shown before downloading, so a too-large range can be narrowed first. */
export async function previewExport(tenantId: number, q: ExportQuery) {
  const form = await formName(tenantId, q.formId);
  const rows = await matching(tenantId, q);
  const pdfs = rows.filter((r) => r.HasPdf === 1).length;
  return { form, pdfs, pending: rows.length - pdfs, max: MAX_EXPORT, fileName: zipName(form, q) };
}

/** e.g. Timesheet_PDFs_01102026-31102026.zip */
const zipName = (form: string, q: ExportQuery) => `${fileFormPart(form)}_PDFs_${ddmmyyyy(q.from)}-${ddmmyyyy(q.to)}.zip`;

/** A stored value as it reads in a spreadsheet cell: numbers as numbers, the rest as text. */
function cell(f: FieldValue): string | number | null {
  if (f.value === null || f.value === '') return null;
  switch (f.type) {
    case 'number': case 'currency': case 'range': { const n = Number(f.value); return Number.isFinite(n) ? n : f.value; }
    case 'checkbox': return f.value === 'true' ? 'Yes' : 'No';
    case 'date': return usDate(f.value);
    case 'sigpad': return 'Signed';
    case 'multiselect': try { return (JSON.parse(f.value) as string[]).join(', '); } catch { return f.value; }
    case 'grid': try { const n = (JSON.parse(f.value) as { rows: unknown[] }).rows.length; return `${n} row${n === 1 ? '' : 's'}`; } catch { return f.value; }
    default: return f.value;
  }
}
const us = (d: Date | null) => (d ? `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}` : null);

/** Checks the range, then writes the ZIP to `out`. Throws (before writing anything) when it is empty or too large. */
export async function writeExport(tenantId: number, q: ExportQuery, out: Writable, onReady: (fileName: string, count: number) => void): Promise<number> {
  const form = await formName(tenantId, q.formId);
  const ids = (await matching(tenantId, q)).filter((r) => r.HasPdf === 1).map((r) => r.RequestId);
  if (!ids.length) throw new AppError(404, 'nothing_to_export', 'No PDFs match: no finished requests of this form were submitted in that range.');
  if (ids.length > MAX_EXPORT) throw new AppError(400, 'too_many', `${ids.length} PDFs match - at most ${MAX_EXPORT} can be exported at a time. Choose a shorter date range.`);

  onReady(zipName(form, q), ids.length);
  const zip = archiver('zip', { zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => { out.on('finish', resolve); out.on('close', resolve); zip.on('error', reject); });
  zip.pipe(out);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Index');
  const fieldCols: { key: string; label: string }[] = [];
  const rows: { name: string; detail: NonNullable<Awaited<ReturnType<typeof loadRequestDetail>>> }[] = [];
  const used = new Set<string>();
  for (const id of ids) {
    const detail = await loadRequestDetail(tenantId, id);
    const doc = await loadDocument(tenantId, id);
    if (!detail || !doc) continue;
    let name = archiveFileName(detail);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = archiveFileName(detail).replace(/\.pdf$/, ` (${n}).pdf`);
    used.add(name.toLowerCase());
    zip.append(doc.content, { name, store: true }); // a PDF is already compressed
    for (const f of detail.data) if (!fieldCols.some((c) => c.key === f.key)) fieldCols.push({ key: f.key, label: f.label });
    rows.push({ name, detail });
  }

  ws.columns = [
    { header: 'File name', key: 'file', width: 34 },
    { header: 'Request', key: 'request', width: 13 },
    { header: 'Form', key: 'form', width: 22 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Submitted by', key: 'submitter', width: 22 },
    { header: 'Submitted', key: 'submitted', width: 12 },
    { header: 'Decided', key: 'decided', width: 12 },
    { header: 'Approval steps', key: 'steps', width: 60 },
    { header: 'Rejection reason', key: 'reason', width: 30 },
    ...fieldCols.map((c) => ({ header: c.label, key: `f:${c.key}`, width: Math.min(40, Math.max(12, c.label.length + 2)) })),
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  for (const { name, detail: d } of rows) {
    const values: Record<string, unknown> = {
      file: { text: name, hyperlink: name }, // opens the PDF beside Index.xlsx once the ZIP is unpacked
      request: d.requestNumber,
      form: d.formName,
      status: d.status,
      submitter: d.submitterName,
      submitted: us(d.submittedAt),
      decided: us(d.closedAt),
      steps: d.steps
        .filter((s) => s.status === 'Approved' || s.status === 'Rejected')
        .map((s) => `${s.name}: ${s.actedBy ?? s.assignedTo} - ${s.status.toLowerCase()} ${us(s.actedAt) ?? ''}`.trim())
        .join('; '),
      reason: d.rejectionReason,
    };
    for (const f of d.data) values[`f:${f.key}`] = cell(f);
    const row = ws.addRow(values);
    row.getCell('file').font = { color: { argb: 'FF1D4ED8' }, underline: true };
  }
  zip.append(Buffer.from(await wb.xlsx.writeBuffer()), { name: 'Index.xlsx' });
  await zip.finalize();
  await done;
  return rows.length;
}
