// Builds the PDF manuals from the content files in this folder.
//   node docs/manuals/build-manuals.cjs            (the three in-app manuals)
//   node docs/manuals/build-manuals.cjs release    (only content-release.cjs: the release process guide; any content-<name>.cjs the same way)
// Uses the pdfkit already installed for the server. Text supports **bold**. Block types:
//   h1 (starts a new page, appears in the contents), h2, p, ul, ol, note {kind: note|important|tip}, table {head, rows, widths},
//   img {img: 'screens/x.jpg', caption?, width? (share of the page width), maxH? (points)},
//   task {task: title (listed in the contents), need?, steps: [text | {text, img, width?, maxH?}], result?, trouble?: [text]}
// Pages are US Letter. Screenshots come from screenshots.cjs (docs/manuals/screens).
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const PDFDocument = createRequire(path.join(__dirname, '..', '..', 'server', 'package.json'))('pdfkit');

const WIN = 'C:\\Windows\\Fonts\\';
const arial = ['arial.ttf', 'arialbd.ttf', 'ariali.ttf'].every((f) => fs.existsSync(WIN + f));
const F = arial ? { r: WIN + 'arial.ttf', b: WIN + 'arialbd.ttf', i: WIN + 'ariali.ttf' } : { r: 'Helvetica', b: 'Helvetica-Bold', i: 'Helvetica-Oblique' };
const LOGO = path.join(__dirname, 'filebank-logo.png'); // also the app's About window (client/public/filebank-logo.png)
const CONTACT = { web: 'filebankinc.com', url: 'https://filebankinc.com', phone: '973-279-4411' }; // as server/src/about/routes.ts
const C = { ink: '#111827', muted: '#5b6472', rule: '#d9dde3', soft: '#f3f4f6', accent: '#1d4ed8', accentSoft: '#eff4ff', warn: '#92400e', warnSoft: '#fef3c7', ok: '#166534', okSoft: '#e8f6ec' };
const M = { left: 60, right: 60, top: 78, bottom: 66 };

function render(manual, outFile, tocPageNumbers) {
  const doc = new PDFDocument({ size: manual.size ?? 'LETTER', margins: M, bufferPages: true, info: { Title: manual.title, Author: manual.brand ?? 'FileBank WorkFlow', Subject: manual.subtitle } });
  const stream = fs.createWriteStream(outFile);
  doc.pipe(stream);
  const W = doc.page.width - M.left - M.right;
  const bottom = () => doc.page.height - M.bottom;
  const headings = [];
  const plain = (t) => t.replace(/\*\*/g, '');

  const measure = (text, width, size) => doc.font(text.includes('**') ? F.b : F.r).fontSize(size).heightOfString(plain(text), { width, lineGap: 2 }) * 1.04;
  const rowH = (cells, widths, header) => Math.max(...cells.map((c, i) => measure(header ? `**${c}**` : c, widths[i] - 12, 9.5))) + 10;
  const tableWidths = (t) => (t.widths || t.head.map(() => 1 / t.head.length)).map((f) => f * W);
  const tableH = (t) => { const w = tableWidths(t); return rowH(t.head, w, true) + t.rows.reduce((a, r) => a + rowH(r, w, false), 0) + 12; };
  const KEEP_WHOLE = 420; // tables up to this height are never split across pages
  const ensure = (h) => { if (doc.y + h > bottom()) { doc.addPage(); doc.x = M.left; doc.y = M.top; } };
  function rich(text, x, y, width, size, color = C.ink) {
    const segs = text.split('**').map((s, i) => ({ s, bold: i % 2 === 1 })).filter((p) => p.s !== '');
    doc.fontSize(size).fillColor(color);
    segs.forEach((p, i) => {
      doc.font(p.bold ? F.b : F.r);
      const o = { width, lineGap: 2, continued: i < segs.length - 1 };
      if (i === 0) doc.text(p.s, x, y, o); else doc.text(p.s, o);
    });
    doc.x = M.left;
  }

  // ---- cover ----
  // the FileBank logo and contact line on FileBank's own documents (not on, say, the network notes)
  const filebank = (manual.brand ?? 'FileBank WorkFlow') === 'FileBank WorkFlow';
  doc.rect(0, 0, doc.page.width, 300).fill(C.accent);
  if (filebank) {
    doc.roundedRect(M.left - 8, 34, 132, 60, 6).fill('#ffffff');
    doc.image(LOGO, M.left, 40, { height: 48 });
  }
  doc.fillColor('#ffffff').font(F.r).fontSize(13).text(manual.brand ?? 'FileBank WorkFlow', M.left, 120, { characterSpacing: 1.5 });
  doc.font(F.b).fontSize(34).text(manual.title, M.left, 150, { width: W });
  doc.font(F.r).fontSize(14).text(manual.subtitle, M.left, doc.y + 8, { width: W });
  doc.fillColor(C.ink).font(F.r).fontSize(11).text(manual.audience, M.left, 340, { width: W, lineGap: 3 });
  doc.fillColor(C.muted).fontSize(10).text(`Version ${manual.version}  ·  ${manual.date}`, M.left, doc.page.height - 120);
  if (filebank) doc.text(`Contact us: ${CONTACT.web}  ·  Tel: ${CONTACT.phone}`, M.left, doc.page.height - 104, { link: CONTACT.url, underline: false });

  // ---- contents ----
  doc.addPage();
  doc.font(F.b).fontSize(20).fillColor(C.ink).text('Contents', M.left, M.top);
  doc.moveDown(0.8);
  let n = 0;
  manual.blocks.filter((b) => b.h1 || b.task).forEach((b, i) => {
    const page = tocPageNumbers ? String(tocPageNumbers[i]) : '';
    if (b.h1) {
      if (doc.y + 44 > bottom()) { doc.addPage(); doc.y = M.top; }
      doc.y += n ? 8 : 0;
      const y = doc.y;
      doc.font(F.b).fontSize(11.5).fillColor(C.ink).text(`${++n}.  ${b.h1}`, M.left, y, { width: W - 40, lineBreak: false });
      doc.fillColor(C.muted).text(page, M.left, y, { width: W, align: 'right', lineBreak: false });
      doc.moveTo(M.left, y + 17).lineTo(M.left + W, y + 17).lineWidth(0.5).strokeColor(C.rule).stroke();
      doc.y = y + 22;
    } else {
      if (doc.y + 18 > bottom()) { doc.addPage(); doc.y = M.top; }
      const y = doc.y;
      doc.font(F.r).fontSize(10).fillColor(C.ink).text(b.task, M.left + 22, y, { width: W - 70, lineBreak: false });
      doc.fillColor(C.muted).text(page, M.left, y, { width: W, align: 'right', lineBreak: false });
      doc.y = y + 16;
    }
  });

  // ---- pictures ----
  // a screenshot, scaled to `share` of the width (never taller than maxH), framed; a new page when it does not fit
  const images = new Map();
  /** How big a screenshot will be drawn: `share` of the width at x, never taller than maxH. */
  function picSize(src, x, share, maxH) {
    const file = path.join(__dirname, src);
    if (!fs.existsSync(file)) throw new Error(`missing screenshot ${src} - run screenshots.cjs`);
    if (!images.has(file)) images.set(file, doc.openImage(file));
    const img = images.get(file);
    const avail = (W - (x - M.left)) * (share ?? 1);
    let w = avail, h = (w * img.height) / img.width;
    const cap = Math.min(maxH ?? 330, bottom() - M.top - 30);
    if (h > cap) { h = cap; w = (h * img.width) / img.height; }
    return { img, w, h, avail };
  }
  function picture(src, x, share, maxH, caption) {
    let { img, w, h, avail } = picSize(src, x, share, maxH);
    const capH = caption ? measure(caption, avail, 8.5) + 4 : 0;
    // nearly fits: shrink it a little rather than leave a large gap and start a new page
    const room = bottom() - doc.y - capH - 14;
    if (h > room && room >= h * 0.8) { w = (w * room) / h; h = room; }
    ensure(h + capH + 14);
    const y = doc.y + 4;
    doc.image(img, x, y, { width: w, height: h });
    doc.rect(x, y, w, h).lineWidth(0.6).strokeColor(C.rule).stroke();
    doc.y = y + h + 6;
    if (caption) { rich(caption, x, doc.y, avail, 8.5, C.muted); doc.y += 2; }
    doc.y += 6;
  }
  function box(text, kind) {
    const [bg, bar, label] = kind === 'result' ? [C.okSoft, C.ok, 'Result'] : kind === 'trouble' ? [C.warnSoft, C.warn, 'If something goes wrong'] : kind === 'important' ? [C.warnSoft, C.warn, 'Important'] : kind === 'tip' ? [C.okSoft, C.ok, 'Tip'] : [C.accentSoft, C.accent, 'Note'];
    const lines = Array.isArray(text) ? text : [text];
    const h = lines.reduce((a, l) => a + measure(l, W - 40, 10) + 3, 0) + 27;
    ensure(h + 8);
    const y = doc.y;
    doc.rect(M.left, y, W, h).fill(bg);
    doc.rect(M.left, y, 3, h).fill(bar);
    doc.font(F.b).fontSize(9).fillColor(bar).text(label.toUpperCase(), M.left + 14, y + 9, { characterSpacing: 0.8 });
    doc.y = y + 22;
    for (const l of lines) {
      const ly = doc.y;
      if (lines.length > 1) doc.font(F.r).fontSize(10).fillColor(C.muted).text('•', M.left + 14, ly, { width: 10, lineBreak: false });
      rich(l, M.left + (lines.length > 1 ? 26 : 14), ly, W - 40, 10);
      doc.y += 3;
    }
    doc.y = y + h + 10;
  }

  // ---- body ----
  let chapter = 0;
  for (const b of manual.blocks) {
    if (b.h1) {
      doc.addPage();
      chapter++;
      headings.push(doc.bufferedPageRange().count);
      doc.font(F.b).fontSize(11).fillColor(C.accent).text(`CHAPTER ${chapter}`, M.left, M.top, { characterSpacing: 1 });
      doc.font(F.b).fontSize(22).fillColor(C.ink).text(b.h1, M.left, doc.y + 4, { width: W });
      doc.moveTo(M.left, doc.y + 8).lineTo(M.left + 60, doc.y + 8).lineWidth(3).strokeColor(C.accent).stroke();
      doc.y += 24;
    } else if (b.h2) {
      const next = manual.blocks[manual.blocks.indexOf(b) + 1];
      // keep the heading with what follows: a whole small table, or the first rows of a long one, or a few lines of text
      const nextH = next && next.table ? (tableH(next.table) <= KEEP_WHOLE ? tableH(next.table) : 110) : 50;
      ensure(34 + nextH);
      doc.y += 8;
      doc.font(F.b).fontSize(13.5).fillColor(C.ink).text(b.h2, M.left, doc.y, { width: W });
      doc.y += 5;
    } else if (b.p) {
      ensure(measure(b.p, W, 10.5) + 6);
      rich(b.p, M.left, doc.y, W, 10.5);
      doc.y += 7;
    } else if (b.ul || b.ol) {
      (b.ul || b.ol).forEach((item, i) => {
        const h = measure(item, W - 24, 10.5);
        ensure(h + 4);
        const y = doc.y;
        doc.font(b.ol ? F.b : F.r).fontSize(10.5).fillColor(b.ol ? C.accent : C.muted).text(b.ol ? `${i + 1}.` : '•', M.left + 4, y, { width: 18, lineBreak: false });
        rich(item, M.left + 24, y, W - 24, 10.5);
        doc.y += 4;
      });
      doc.y += 4;
    } else if (b.img) {
      picture(b.img, M.left, b.width, b.maxH, b.caption);
    } else if (b.task) {
      // the title, kept with what follows it: the "You need" line and the first step with its picture
      const first = b.steps?.[0] && (typeof b.steps[0] === 'string' ? { text: b.steps[0] } : b.steps[0]);
      const firstH = first ? measure(first.text, W - 30, 10.5) + 6 + (first.img ? picSize(first.img, M.left + 28, first.width, first.maxH).h * 0.8 + 20 : 0) : 0;
      ensure(Math.max(110, 40 + (b.need ? measure(`**You need:** ${b.need}`, W, 10) + 6 : 0) + firstH));
      doc.y += 10;
      headings.push(doc.bufferedPageRange().count);
      doc.font(F.b).fontSize(14).fillColor(C.ink).text(b.task, M.left, doc.y, { width: W });
      doc.y += 4;
      if (b.need) { rich(`**You need:** ${b.need}`, M.left, doc.y, W, 10, C.muted); doc.y += 6; }
      (b.steps || []).forEach((st, i) => {
        const s = typeof st === 'string' ? { text: st } : st;
        const h = measure(s.text, W - 30, 10.5);
        // a step stays on the same page as its picture (a picture may shrink to 80% to fit, see picture())
        const pic = s.img ? picSize(s.img, M.left + 28, s.width, s.maxH).h * 0.8 + 20 : 0;
        ensure(h + 6 + pic);
        const y = doc.y;
        doc.circle(M.left + 9, y + 7, 9).fill(C.accent);
        doc.font(F.b).fontSize(9.5).fillColor('#ffffff').text(String(i + 1), M.left, y + 2.5, { width: 18, align: 'center', lineBreak: false });
        rich(s.text, M.left + 28, y, W - 28, 10.5);
        doc.y += 5;
        if (s.img) picture(s.img, M.left + 28, s.width, s.maxH, s.caption);
      });
      if (b.result) box(b.result, 'result');
      if (b.trouble) box(b.trouble, 'trouble');
    } else if (b.note) {
      const kind = b.kind || 'note';
      const [bg, bar, label] = kind === 'important' ? [C.warnSoft, C.warn, 'Important'] : kind === 'tip' ? [C.okSoft, C.ok, 'Tip'] : [C.accentSoft, C.accent, 'Note'];
      const h = measure(b.note, W - 28, 10) + 30;
      ensure(h + 8);
      const y = doc.y;
      doc.rect(M.left, y, W, h).fill(bg);
      doc.rect(M.left, y, 3, h).fill(bar);
      doc.font(F.b).fontSize(9).fillColor(bar).text(label.toUpperCase(), M.left + 14, y + 9, { characterSpacing: 0.8 });
      rich(b.note, M.left + 14, y + 22, W - 28, 10);
      doc.y = y + h + 10;
    } else if (b.table) {
      const widths = tableWidths(b.table);
      const drawRow = (cells, header) => {
        const h = rowH(cells, widths, header);
        const y = doc.y;
        if (header) doc.rect(M.left, y, W, h).fill(C.soft);
        let x = M.left;
        cells.forEach((c, i) => {
          rich(header ? `**${plain(c)}**` : c, x + 6, y + 5, widths[i] - 12, 9.5, header ? C.muted : C.ink);
          x += widths[i];
        });
        doc.moveTo(M.left, y + h).lineTo(M.left + W, y + h).lineWidth(0.5).strokeColor(C.rule).stroke();
        doc.y = y + h;
      };
      const total = tableH(b.table);
      ensure(total <= KEEP_WHOLE ? total : 110);
      drawRow(b.table.head, true);
      for (const row of b.table.rows) {
        if (doc.y + rowH(row, widths, false) > bottom()) {
          doc.addPage(); doc.x = M.left; doc.y = M.top;
          drawRow(b.table.head, true); // long table continues: repeat its header
        }
        drawRow(row, false);
      }
      doc.y += 12;
    }
  }

  // ---- running header / footer (not on the cover) ----
  const range = doc.bufferedPageRange();
  for (let i = 1; i < range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    doc.font(F.r).fontSize(8.5).fillColor(C.muted);
    doc.text(`${manual.brand ?? 'FileBank WorkFlow'}  ·  ${manual.title}`, M.left, 40, { width: W, lineBreak: false });
    if (filebank) doc.image(LOGO, M.left + W - 34, 32, { height: 14 });
    doc.moveTo(M.left, 56).lineTo(M.left + W, 56).lineWidth(0.5).strokeColor(C.rule).stroke();
    doc.text(`Page ${i + 1} of ${range.count}`, M.left, doc.page.height - 44, { width: W, align: 'center', lineBreak: false });
  }
  doc.end();
  return new Promise((resolve) => stream.on('finish', () => resolve({ headings, pages: range.count })));
}

(async () => {
  // node build-manuals.cjs release  builds only content-release.cjs; no names = the three in-app manuals
  const names = process.argv.slice(2);
  for (const name of names.length ? names : ['user', 'admin', 'global']) {
    const manual = require(`./content-${name}.cjs`);
    const out = path.join(__dirname, manual.file);
    const first = await render(manual, out, null); // pass 1 finds the chapter page numbers
    const final = await render(manual, out, first.headings); // pass 2 prints them in the contents
    console.log(`${manual.file}: ${final.pages} pages`);
  }
  if (!names.length) require('./build-process-flow.cjs'); // the workflow sheet, also under Help
})();
