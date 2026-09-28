import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { config } from '../config';
import { SIG_H, SIG_W, parseSignature, sigPathData } from '../forms/sigpad';
import type { GridValue } from '../forms/validation';
import type { FieldValue, RequestDetail } from '../workflow/read';

export interface AuditRow {
  occurredAt: Date;
  action: string;
  userName: string | null;
  ip: string | null;
  fromState: string | null;
  toState: string | null;
}

const M = { left: 50, right: 50, top: 92, bottom: 56 };
const COLORS = { approved: '#166534', rejected: '#b42318', text: '#111827', muted: '#6b7280', rule: '#d1d5db', soft: '#f3f4f6' };

// Arial (present on every Windows Server) is embedded for full Unicode coverage; the built-in
// Helvetica only covers Latin-1. Tests use Helvetica so the output does not depend on the host.
const WIN_FONTS = 'C:\\Windows\\Fonts\\';
const useArial = !config.isTest && ['arial.ttf', 'arialbd.ttf', 'ariali.ttf'].every((f) => fs.existsSync(WIN_FONTS + f));
const FONT = useArial
  ? { regular: `${WIN_FONTS}arial.ttf`, bold: `${WIN_FONTS}arialbd.ttf`, italic: `${WIN_FONTS}ariali.ttf` }
  : { regular: 'Helvetica', bold: 'Helvetica-Bold', italic: 'Helvetica-Oblique' };

const fmt = (d: Date | null) => (d ? `${d.toISOString().slice(0, 19).replace('T', ' ')} UTC` : '-');

function display(f: FieldValue): string {
  if (f.value === null || f.value === '') return '-';
  if (f.type === 'checkbox') return f.value === 'true' ? 'Yes' : 'No';
  if (f.type === 'multiselect') {
    try {
      return (JSON.parse(f.value) as string[]).join(', ') || '-';
    } catch {
      return f.value;
    }
  }
  if (f.type === 'datetime') return f.value.replace('T', ' ');
  return f.value;
}

/**
 * One PDF for both outcomes. Approved and Rejected differ only in the banner, the title and
 * the rejection block; content is: request summary, full submission, every completed approver
 * section (name, decision, fields, comments, timestamp), then the audit summary.
 */
export function buildRequestPdf(d: RequestDetail, auditRows: AuditRow[]): Promise<Buffer> {
  const rejected = d.status === 'Rejected';
  const banner = rejected ? 'REJECTED' : 'APPROVED';
  const doc = new PDFDocument({
    size: 'A4',
    margins: M,
    bufferPages: true,
    compress: !config.isTest,
    info: { Title: `${banner} - ${d.formName} ${d.requestNumber}`, Author: 'Approvals', Subject: `${d.formName} approval record`, CreationDate: d.closedAt ?? new Date() },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - M.left - M.right;
  const bottom = () => doc.page.height - M.bottom;

  const drawBanner = () => {
    doc.save();
    doc.rect(0, 0, doc.page.width, 64).fill(rejected ? COLORS.rejected : COLORS.approved);
    doc.fillColor('#ffffff').font(FONT.bold).fontSize(22).text(banner, M.left, 20, { lineBreak: false });
    doc.font(FONT.regular).fontSize(10).text(`${d.formName}  |  ${d.requestNumber}`, M.left, 27, { width, align: 'right', lineBreak: false });
    doc.restore();
    doc.fillColor(COLORS.text).font(FONT.regular).fontSize(10);
    doc.x = M.left;
    doc.y = M.top;
  };
  doc.on('pageAdded', drawBanner);
  drawBanner();

  const ensure = (height: number) => {
    if (doc.y + height > bottom()) doc.addPage();
  };
  const heading = (text: string) => {
    ensure(48);
    doc.moveDown(0.8);
    doc.font(FONT.bold).fontSize(13).fillColor(COLORS.text).text(text, M.left, doc.y, { width });
    doc.moveTo(M.left, doc.y + 3).lineTo(M.left + width, doc.y + 3).lineWidth(0.8).strokeColor(COLORS.rule).stroke();
    doc.y += 10;
  };
  const LABEL_W = 165;
  const row = (label: string, value: string, opts: { italic?: boolean; color?: string } = {}) => {
    doc.font(FONT.regular).fontSize(9);
    const lh = doc.heightOfString(label, { width: LABEL_W - 10 });
    doc.font(opts.italic ? FONT.italic : FONT.regular).fontSize(10);
    const vh = doc.heightOfString(value, { width: width - LABEL_W });
    ensure(Math.min(Math.max(lh, vh), 300) + 6);
    const y = doc.y;
    doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted).text(label, M.left, y + 1, { width: LABEL_W - 10 });
    doc.font(opts.italic ? FONT.italic : FONT.regular).fontSize(10).fillColor(opts.color ?? COLORS.text).text(value, M.left + LABEL_W, y, { width: width - LABEL_W });
    doc.y = Math.max(doc.y, y + lh) + 5;
    doc.x = M.left;
  };
  // A data grid: its label, then one table line per stored row and a bold totals line. Falls back to the raw text if the value is not a grid snapshot.
  const grid = (f: FieldValue) => {
    let g: GridValue;
    try {
      g = JSON.parse(f.value ?? '') as GridValue;
      if (!Array.isArray(g.columns) || !Array.isArray(g.rows) || g.columns.length === 0) throw new Error('not a grid');
    } catch {
      return row(f.label, display(f));
    }
    const numeric = (t: string) => t === 'number' || t === 'currency' || t === 'calc';
    const colW = width / g.columns.length;
    const line = (cells: string[], bold = false, shade = false) => {
      doc.font(bold ? FONT.bold : FONT.regular).fontSize(8.5);
      const h = Math.max(...cells.map((c) => doc.heightOfString(c || ' ', { width: colW - 8 })));
      ensure(h + 7);
      doc.font(bold ? FONT.bold : FONT.regular).fontSize(8.5); // a page break redraws the banner, which resets the font
      const y = doc.y;
      if (shade) doc.rect(M.left, y - 2, width, h + 6).fill(COLORS.soft);
      cells.forEach((c, i) => doc.fillColor(COLORS.text).text(c, M.left + i * colW + 4, y + 1, { width: colW - 8, align: numeric(g.columns[i].type) ? 'right' : 'left' }));
      doc.moveTo(M.left, y + h + 4).lineTo(M.left + width, y + h + 4).lineWidth(0.5).strokeColor(COLORS.rule).stroke();
      doc.y = y + h + 6;
      doc.x = M.left;
    };
    ensure(40);
    doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted).text(f.label, M.left, doc.y + 1, { width });
    doc.y += 3;
    line(g.columns.map((c) => c.label), true, true);
    g.rows.forEach((r) => line(g.columns.map((c) => r[c.key] ?? '')));
    if (Object.keys(g.totals ?? {}).length) line(g.columns.map((c, i) => g.totals[c.key] ?? (i === 0 ? 'Total' : '')), true);
    doc.y += 4;
  };
  // A drawn signature: the label, with the pen strokes as vector lines in a box beside it.
  const drawnSignature = (f: FieldValue) => {
    const sig = parseSignature(f.value);
    if (!sig) return row(f.label, '-');
    const scale = 0.4, boxW = SIG_W * scale, boxH = SIG_H * scale;
    ensure(boxH + 8);
    const y = doc.y;
    doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted).text(f.label, M.left, y + 1, { width: LABEL_W - 10 });
    doc.save();
    doc.translate(M.left + LABEL_W, y).scale(scale);
    doc.path(sigPathData(sig.strokes)).lineWidth(2.5).lineCap('round').lineJoin('round').strokeColor(COLORS.text).stroke();
    doc.restore();
    doc.moveTo(M.left + LABEL_W, y + boxH).lineTo(M.left + LABEL_W + boxW, y + boxH).lineWidth(0.5).strokeColor(COLORS.rule).stroke();
    doc.y = y + boxH + 7;
    doc.x = M.left;
  };
  const fields = (items: FieldValue[]) =>
    items.forEach((f) => (f.type === 'grid' && f.value ? grid(f) : f.type === 'sigpad' && f.value ? drawnSignature(f) : row(f.label, display(f), { italic: f.type === 'signature' })));

  // ---- summary ----
  doc.font(FONT.bold).fontSize(16).text(`${d.formName} - ${d.requestNumber}`, M.left, doc.y, { width });
  doc.moveDown(0.4);
  row('Outcome', rejected ? `Rejected at step ${d.rejectedStepOrder} of ${d.totalSteps}` : `Approved - all ${d.totalSteps} step(s) complete`, { color: rejected ? COLORS.rejected : COLORS.approved });
  row('Submitted by', d.submitterName);
  row('Submitted', fmt(d.submittedAt));
  row(rejected ? 'Rejected' : 'Completed', fmt(d.closedAt));
  if (rejected) row('Rejection reason', d.rejectionReason ?? '-', { color: COLORS.rejected });

  // ---- submission ----
  heading('Submission');
  fields(d.data);

  // ---- approver sections, up to and including the deciding step ----
  heading('Approval history');
  for (const s of d.steps) {
    if (s.status !== 'Approved' && s.status !== 'Rejected') continue;
    ensure(70);
    const y = doc.y;
    doc.rect(M.left, y, width, 20).fill(COLORS.soft);
    doc.font(FONT.bold).fontSize(10.5).fillColor(COLORS.text).text(`Step ${s.stepOrder} of ${d.totalSteps}: ${s.name}`, M.left + 8, y + 5, { width: width - 110, lineBreak: false });
    doc.fillColor(s.status === 'Rejected' ? COLORS.rejected : COLORS.approved).text(s.status.toUpperCase(), M.left, y + 5, { width: width - 8, align: 'right', lineBreak: false });
    doc.y = y + 27;
    doc.x = M.left;
    row('Approver', s.actedBy ?? s.assignedTo);
    row('Decision', s.status);
    row('Date', fmt(s.actedAt));
    if (s.actedIp) row('IP address', s.actedIp);
    fields(s.responses);
    if (s.comments) row('Comments', s.comments);
    if (s.signature) drawnSignature({ key: 'signature', label: 'Signature', type: 'sigpad', value: s.signature });
    if (s.status === 'Rejected') row('Rejection reason', d.rejectionReason ?? '-', { color: COLORS.rejected });
    doc.moveDown(0.5);
  }
  const notReached = d.steps.filter((s) => s.status === 'NotReached');
  if (notReached.length) {
    ensure(20);
    doc.font(FONT.italic).fontSize(9).fillColor(COLORS.muted)
      .text(`Not reached because of the rejection: ${notReached.map((s) => `step ${s.stepOrder} (${s.name}, ${s.assignedTo})`).join('; ')}.`, M.left, doc.y, { width });
  }

  // ---- audit summary ----
  heading('Audit summary');
  const cols = [118, 150, 125, width - 393];
  const auditLine = (cells: string[], bold = false) => {
    doc.font(bold ? FONT.bold : FONT.regular).fontSize(8);
    const h = Math.max(...cells.map((c, i) => doc.heightOfString(c, { width: cols[i] - 6 })));
    ensure(h + 5);
    doc.font(bold ? FONT.bold : FONT.regular).fontSize(8); // a page break redraws the banner, which resets the font
    const y = doc.y;
    let x = M.left;
    cells.forEach((c, i) => {
      doc.fillColor(bold ? COLORS.muted : COLORS.text).text(c, x, y, { width: cols[i] - 6 });
      x += cols[i];
    });
    doc.y = y + h + 4;
    doc.x = M.left;
  };
  auditLine(['Time', 'Event', 'User', 'IP address'], true);
  for (const a of auditRows) {
    auditLine([fmt(a.occurredAt), a.action + (a.toState ? `  (${a.fromState ?? '-'} > ${a.toState})` : ''), a.userName ?? 'System', a.ip ?? '-']);
  }

  // ---- footer on every page ----
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // allow drawing below the content area without triggering a new page
    doc.font(FONT.regular).fontSize(8).fillColor(COLORS.muted)
      .text(`${banner}  |  ${d.requestNumber}  |  Generated ${fmt(new Date())}  |  Page ${i + 1} of ${range.count}`, M.left, doc.page.height - 34, { width, align: 'center', lineBreak: false });
  }
  doc.end();
  return done;
}

/** [FormName]_[RequestID]_[YYYYMMDD].pdf, or ..._REJECTED_... ; safe as a file name anywhere (no " * : < > ? / \ | # %). */
export function archiveFileName(d: Pick<RequestDetail, 'formName' | 'requestNumber' | 'status' | 'closedAt'>): string {
  const form = d.formName.normalize('NFKC').replace(/["*:<>?/\\|#%~&{}]+/g, '').trim().replace(/\s+/g, '-').replace(/^\.+|\.+$/g, '').slice(0, 80) || 'Form';
  const date = (d.closedAt ?? new Date()).toISOString().slice(0, 10).replace(/-/g, '');
  return `${form}_${d.requestNumber}_${d.status === 'Rejected' ? 'REJECTED_' : ''}${date}.pdf`;
}
