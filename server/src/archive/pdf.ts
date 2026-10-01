import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { config } from '../config';
import { SIG_H, SIG_W, parseSignature, sigPathData } from '../forms/sigpad';
import type { GridValue } from '../forms/validation';
import { emailValue } from '../workflow/emailDetails';
import type { FieldValue, RequestDetail } from '../workflow/read';

export interface AuditRow {
  occurredAt: Date;
  action: string;
  userName: string | null;
  ip: string | null;
  fromState: string | null;
  toState: string | null;
}

const M = { left: 50, right: 50, top: 96, bottom: 56 };
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

/** The customer at the top of every page: its name, and its logo when that is a PNG or JPEG (the only images PDFKit can embed). */
export interface PdfBrand {
  name: string;
  logoDataUrl: string | null;
}

const EMBEDDABLE_LOGO = /^data:image\/(png|jpe?g);base64,[A-Za-z0-9+/=\s]+$/;

/**
 * One PDF for both outcomes. Approved and Rejected differ only in the banner, the title and
 * the rejection block; content is: request summary, full submission, every completed approver
 * section (name, decision, fields, comments, timestamp), then the audit summary.
 */
export function buildRequestPdf(d: RequestDetail, auditRows: AuditRow[], brand?: PdfBrand): Promise<Buffer> {
  const rejected = d.status === 'Rejected';
  const banner = rejected ? 'REJECTED' : 'APPROVED';
  const doc = new PDFDocument({
    size: 'A4',
    margins: M,
    bufferPages: true,
    compress: !config.isTest,
    info: { Title: `${banner} - ${d.formName} ${d.requestNumber}`, Author: 'FileBank WorkFlow', Subject: `${d.formName} approval record`, CreationDate: d.closedAt ?? new Date() },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - M.left - M.right;
  const bottom = () => doc.page.height - M.bottom;

  // Header on every page: the customer's logo and name on the left; the outcome, form and request number on the right;
  // and a band in the outcome's colour underneath, so the result is plain at a glance on any page.
  const statusColor = rejected ? COLORS.rejected : COLORS.approved;
  // the logo is read once (and embedded once, however many pages), scaled to fit 130 x 40 without stretching
  let logo: { img: unknown; w: number; h: number } | null = null;
  if (brand?.logoDataUrl && EMBEDDABLE_LOGO.test(brand.logoDataUrl)) {
    try {
      const img = (doc as unknown as { openImage(src: string): { width: number; height: number } }).openImage(brand.logoDataUrl);
      const scale = Math.min(130 / img.width, 40 / img.height);
      logo = { img, w: img.width * scale, h: img.height * scale };
    } catch {
      logo = null; // not a readable PNG/JPEG after all: the name alone
    }
  }
  const drawBanner = () => {
    doc.save();
    let nameX = M.left;
    if (logo) {
      doc.image(logo.img as PDFKit.Mixins.ImageSrc, M.left, 16 + (40 - logo.h) / 2, { width: logo.w, height: logo.h });
      nameX = M.left + logo.w + 12;
    }
    const rightW = 170;
    if (brand?.name) {
      doc.fillColor(COLORS.text).font(FONT.bold).fontSize(14)
        .text(brand.name, nameX, 28, { width: M.left + width - rightW - 10 - nameX, height: 20, ellipsis: true, lineBreak: false });
    }
    // outcome badge, then form and number under it
    doc.font(FONT.bold).fontSize(11);
    const badgeW = doc.widthOfString(banner) + 20;
    const badgeX = M.left + width - badgeW;
    doc.roundedRect(badgeX, 18, badgeW, 20, 4).fill(statusColor);
    doc.fillColor('#ffffff').text(banner, badgeX, 23.5, { width: badgeW, align: 'center', lineBreak: false });
    doc.fillColor(COLORS.muted).font(FONT.regular).fontSize(9)
      .text(`${d.formName}  |  ${d.requestNumber}`, M.left + width - rightW, 44, { width: rightW, align: 'right', height: 12, ellipsis: true, lineBreak: false });
    doc.rect(0, 66, doc.page.width, 4).fill(statusColor);
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

  // ---- send-backs: each time an approver returned it for changes, and what the submitter changed ----
  if (d.returns.length) {
    heading('Sent back for changes');
    for (const x of d.returns) {
      ensure(60);
      row('Sent back', `${fmt(x.returnedAt)} by ${x.returnedBy} at step ${x.stepOrder} (${x.stepName})`);
      row('What to change', x.reason);
      row('Resubmitted', x.resubmittedAt ? fmt(x.resubmittedAt) : '-');
      if (x.resubmitNote) row('Submitter\'s note', x.resubmitNote);
      if (x.resubmittedAt) {
        row('Changed', x.changes.length
          ? x.changes.map((c) => `${c.label}: ${emailValue(c.type, c.from) ?? '(empty)'} > ${emailValue(c.type, c.to) ?? '(empty)'}`).join('\n')
          : 'Nothing');
      }
      doc.moveDown(0.5);
    }
  }

  // ---- audit summary ----
  heading('Audit summary');
  const cols = [125, width - 125 - 170, 170];
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
  auditLine(['Time', 'Event', 'User'], true);
  for (const a of auditRows) {
    auditLine([fmt(a.occurredAt), a.action + (a.toState ? `  (${a.fromState ?? '-'} > ${a.toState})` : ''), a.userName ?? 'System']);
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

/**
 * The PDF's file name, archived and downloaded alike: [first 10 characters of the form name]_[request number without
 * "REQ-"]_[submitted date ddmmyyyy].pdf - e.g. Leave-Appl_000207_12122026.pdf. Approved and rejected are named the same.
 * Safe as a file name anywhere (no " * : < > ? / \ | # %).
 */
export function archiveFileName(d: Pick<RequestDetail, 'formName' | 'requestNumber' | 'submittedAt'>): string {
  const form = fileFormPart(d.formName);
  const seq = d.requestNumber.replace(/^REQ-/i, ''); // REQ-000123 -> 000123
  const s = new Date(d.submittedAt); // the day it was submitted, server time - the same day as the customer-file day folder
  const date = `${String(s.getDate()).padStart(2, '0')}${String(s.getMonth() + 1).padStart(2, '0')}${s.getFullYear()}`;
  return `${form}_${seq}_${date}.pdf`;
}
const FORM_CHARS = 10;

/** The form name as file names start: spaces as '-', unsafe characters dropped, cut at exactly 10 characters ("Leave-Appl"). */
export function fileFormPart(formName: string): string {
  return formName.normalize('NFKC').replace(/["*:<>?/\\|#%~&{}]+/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-')
    .replace(/^[.-]+/, '').slice(0, FORM_CHARS).replace(/[.-]+$/, '') || 'Form';
}
