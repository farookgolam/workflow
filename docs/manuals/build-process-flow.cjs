// The workflow sheet under Help in the app: node docs/manuals/build-process-flow.cjs -> ApprovalFlow-Process-Flow.pdf
// (build-manuals.cjs runs it too). Page 1: the diagram with numbered steps; page 2: each step explained.
// Uses PDFKit from the server's node_modules (npm install in server/ first).
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('node:module').createRequire(path.join(__dirname, '..', '..', 'server', 'package.json'))('pdfkit');

const OUT = path.join(__dirname, 'ApprovalFlow-Process-Flow.pdf');
const WIN = 'C:/Windows/Fonts/';
const FONT = fs.existsSync(`${WIN}arial.ttf`)
  ? { r: `${WIN}arial.ttf`, b: `${WIN}arialbd.ttf` }
  : { r: 'Helvetica', b: 'Helvetica-Bold' };

// the app's own colours
const C = {
  ink: '#080803', text: '#1f2328', muted: '#5b6169', rule: '#d9d6cc', soft: '#f6f4ee',
  yellow: '#fee54d', ok: '#15803d', okSoft: '#e7f4ea', bad: '#b42318', badSoft: '#fcebe9',
  back: '#6d28d9', backSoft: '#f1ebfd', warn: '#b4410b', node: '#ffffff',
};

const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 0, bufferPages: true, info: { Title: 'ApprovalFlow - Request workflow', Author: 'ApprovalFlow' } });
doc.pipe(fs.createWriteStream(OUT));
const W = doc.page.width; // 792
const H = doc.page.height; // 612
const M = 36;

// ---- header ----
doc.rect(0, 0, W, 6).fill(C.yellow);
doc.font(FONT.b).fontSize(20).fillColor(C.ink).text('ApprovalFlow  |  Request workflow', M, 26);
doc.font(FONT.r).fontSize(10).fillColor(C.muted)
  .text('How a request moves from submission to a final, signed and archived decision.', M, 51);

// ---- swimlanes ----
const LANE_X = M, LABEL_W = 62, TOP = 78, LANE_H = 140;
const lanes = [
  { name: 'Requester', sub: 'submits and fixes' },
  { name: 'Approver', sub: 'one per step' },
  { name: 'System', sub: 'automatic' },
];
lanes.forEach((l, i) => {
  const y = TOP + i * LANE_H;
  doc.rect(LANE_X, y, W - 2 * M, LANE_H).fill(i % 2 ? '#fbfaf6' : C.soft);
  doc.rect(LANE_X, y, LABEL_W, LANE_H).fill(C.ink);
  doc.save().rotate(-90, { origin: [LANE_X + LABEL_W / 2, y + LANE_H / 2] });
  doc.font(FONT.b).fontSize(12).fillColor('#ffffff').text(l.name, LANE_X + LABEL_W / 2 - 60, y + LANE_H / 2 - 13, { width: 120, align: 'center' });
  doc.font(FONT.r).fontSize(8).fillColor(C.yellow).text(l.sub, LANE_X + LABEL_W / 2 - 60, y + LANE_H / 2 + 3, { width: 120, align: 'center' });
  doc.restore();
});
doc.rect(LANE_X, TOP, W - 2 * M, LANE_H * 3).lineWidth(0.8).strokeColor(C.rule).stroke();
const laneY = (i) => TOP + i * LANE_H + LANE_H / 2;

// columns
const X = [160, 285, 410, 560, 692];
const NW = 110, NH = 50;

// ---- shapes ----
function label(text, cx, cy, w, { size = 8.5, bold = true, color = C.text } = {}) {
  doc.font(bold ? FONT.b : FONT.r).fontSize(size);
  const h = doc.heightOfString(text, { width: w, align: 'center' });
  doc.fillColor(color).text(text, cx - w / 2, cy - h / 2, { width: w, align: 'center' });
}
function box(cx, cy, title, sub, { fill = C.node, stroke = C.ink, color = C.text, round = 6, w = NW, h = NH } = {}) {
  doc.roundedRect(cx - w / 2, cy - h / 2, w, h, round).lineWidth(1.2).fillAndStroke(fill, stroke);
  doc.font(FONT.b).fontSize(8.8);
  const th = doc.heightOfString(title, { width: w - 12, align: 'center' });
  doc.font(FONT.r).fontSize(7.2);
  const sh = sub ? doc.heightOfString(sub, { width: w - 12, align: 'center' }) + 2 : 0;
  let y = cy - (th + sh) / 2;
  doc.font(FONT.b).fontSize(8.8).fillColor(color).text(title, cx - w / 2 + 6, y, { width: w - 12, align: 'center' });
  if (sub) doc.font(FONT.r).fontSize(7.2).fillColor(C.muted).text(sub, cx - w / 2 + 6, y + th + 2, { width: w - 12, align: 'center' });
}
function diamond(cx, cy, text, { w = 92, h = 62 } = {}) {
  doc.polygon([cx, cy - h / 2], [cx + w / 2, cy], [cx, cy + h / 2], [cx - w / 2, cy]).lineWidth(1.2).fillAndStroke(C.yellow, C.ink);
  label(text, cx, cy, w - 30, { size: 8.8 });
}
function arrow(points, { color = C.ink, dash = false } = {}) {
  doc.save().lineWidth(1.3).strokeColor(color);
  if (dash) doc.dash(4, { space: 3 });
  doc.moveTo(...points[0]);
  points.slice(1).forEach((p) => doc.lineTo(...p));
  doc.stroke().undash();
  const [x1, y1] = points[points.length - 2];
  const [x2, y2] = points[points.length - 1];
  const a = Math.atan2(y2 - y1, x2 - x1), s = 6;
  doc.polygon([x2, y2], [x2 - s * Math.cos(a - 0.45), y2 - s * Math.sin(a - 0.45)], [x2 - s * Math.cos(a + 0.45), y2 - s * Math.sin(a + 0.45)]).fill(color);
  doc.restore();
}
function tag(text, x, y, color) {
  doc.font(FONT.b).fontSize(7.5);
  const w = doc.widthOfString(text) + 10;
  doc.roundedRect(x - w / 2, y - 7, w, 14, 7).fill(color);
  doc.fillColor('#ffffff').text(text, x - w / 2, y - 4.2, { width: w, align: 'center' });
}

const [yR, yA, yS] = [laneY(0), laneY(1), laneY(2)];

// ---- nodes ----
box(X[0], yR, 'Fill in and submit the form', 'Signs if the form asks for it', { fill: C.yellow, round: 24 });
box(X[2], yR, 'Make the changes and resubmit', 'Form comes pre-filled, with the approver\'s request on top', { fill: C.backSoft, stroke: C.back });

box(X[0], yS, 'Request created', 'Number REQ-000123 given; confirmation emailed');
box(X[1], yA, 'Review the request', 'From the email (details + buttons) or "Waiting for my approval"');
diamond(X[2], yA, 'Decision');
box(X[3], yA, 'Sign and approve', 'Drawn signature; may choose the next approver', { fill: C.okSoft, stroke: C.ok });

box(X[1], yS, 'Approver emailed', 'Details, Approve / Send back / Reject buttons, personal link');
box(X[2], yS + 8, 'REJECTED - final', 'PDF archived; requester and admin emailed with the reason', { fill: C.badSoft, stroke: C.bad, color: C.bad, round: 24 });
diamond(X[3], yS - 8, 'Last step?', { w: 86, h: 56 });
box(X[4], yS - 8, 'APPROVED - final', 'Signed PDF archived; requester emailed', { fill: C.okSoft, stroke: C.ok, color: C.ok, round: 24 });

// step numbers, matching the "Step by step" table on page 2
function num(n, x, y) {
  doc.circle(x, y, 8).lineWidth(1).fillAndStroke(C.ink, '#ffffff');
  doc.font(FONT.b).fontSize(n > 9 ? 7 : 8).fillColor('#ffffff').text(String(n), x - 8, y - (n > 9 ? 3.6 : 4.2), { width: 16, align: 'center' });
}
const corner = (cx, cy) => [cx - NW / 2 + 2, cy - NH / 2 + 2];
num(1, ...corner(X[0], yR));
num(2, ...corner(X[0], yS));
num(3, ...corner(X[1], yS));
num(4, ...corner(X[1], yA));
num(5, X[2] - 30, yA - 20);
num(6, ...corner(X[3], yA));
num(7, X[3] - 28, yS - 8 - 18);
num(8, ...corner(X[4], yS - 8));
num(9, ...corner(X[2], yR));
num(10, ...corner(X[2], yS + 8));

// ---- arrows ----
const half = NW / 2, hh = NH / 2;
arrow([[X[0], yR + hh], [X[0], yS - hh]]);                                   // submit -> created
arrow([[X[0] + half, yS], [X[1] - half, yS]]);                               // created -> emailed
arrow([[X[1], yS - hh], [X[1], yA + hh]]);                                   // emailed -> review
arrow([[X[1] + half, yA], [X[2] - 46, yA]]);                                 // review -> decision
arrow([[X[2] + 46, yA], [X[3] - half, yA]], { color: C.ok });                // approve
tag('Approve', (X[2] + 46 + X[3] - half) / 2, yA - 14, C.ok);
arrow([[X[2], yA - 31], [X[2], yR + hh]], { color: C.back });                // send back
tag('Send back', X[2] + 30, (yA - 31 + yR + hh) / 2 + 6, C.back);
arrow([[X[2] - half, yR], [X[1], yR], [X[1], yA - hh]], { color: C.back, dash: true }); // resubmit -> same approver
doc.font(FONT.r).fontSize(7.2).fillColor(C.back).text('Resubmitted: back to the same step.\nEarlier approvals stay approved.', X[1] - 58, yR - 32, { width: 150 });
arrow([[X[2], yA + 31], [X[2], yS + 8 - hh]], { color: C.bad });             // reject
tag('Reject', X[2] + 26, (yA + 31 + yS + 8 - hh) / 2 - 2, C.bad);
arrow([[X[3], yA + hh], [X[3], yS - 8 - 28]]);                               // approved -> last step?
arrow([[X[3] + 43, yS - 8], [X[4] - half, yS - 8]], { color: C.ok });         // yes
tag('Yes', (X[3] + 43 + X[4] - half) / 2, yS - 20, C.ok);
// no: next step -> its approver is emailed (back round to "Approver emailed")
const loopY = TOP + LANE_H * 3 - 10;
arrow([[X[3], yS - 8 + 28], [X[3], loopY], [X[1] + 18, loopY], [X[1] + 18, yS + hh]]);
tag('No', X[3] + 18, loopY - 12, C.ink);
doc.font(FONT.r).fontSize(7.2).fillColor(C.muted).text('Next step becomes active and its approver is emailed', X[3] + 34, loopY - 16, { width: 130 });

// ---- notes under the lanes ----
const NY = TOP + LANE_H * 3 + 14;
const cols = [
  { title: 'While a step waits', color: C.warn, text: 'Reminders and escalation run on the step\'s own rules. An administrator can remind, reassign, add a delegate or cancel the request.' },
  { title: 'Signatures and records', color: C.ok, text: 'Every approval needs a drawn signature. The final PDF carries the submission, each decision and signature, any send-backs, and the audit trail.' },
  { title: 'Final means final', color: C.bad, text: 'Approved, Rejected and Cancelled requests cannot be changed. To fix a request, send it back; to try again after a rejection, submit a new one.' },
];
const cw = (W - 2 * M - 2 * 14) / 3;
cols.forEach((c, i) => {
  const x = M + i * (cw + 14);
  doc.rect(x, NY, 3, 58).fill(c.color);
  doc.font(FONT.b).fontSize(9).fillColor(C.text).text(c.title, x + 10, NY + 1, { width: cw - 12 });
  doc.font(FONT.r).fontSize(8).fillColor(C.muted).text(c.text, x + 10, NY + 15, { width: cw - 12, lineGap: 1 });
});

// =====================================================================================
// page 2: step by step
// =====================================================================================
doc.addPage({ size: 'LETTER', layout: 'landscape', margin: 0 });
doc.rect(0, 0, W, 6).fill(C.yellow);
doc.font(FONT.b).fontSize(20).fillColor(C.ink).text('Step by step', M, 26);
doc.font(FONT.r).fontSize(10).fillColor(C.muted)
  .text('Each number matches a box on the workflow diagram (page 1).', M, 51);

const WHO = { Requester: C.warn, Approver: C.ok, System: C.muted };
const steps = [
  [1, 'Fill in and submit the form', 'Requester',
    'Opens the form from the home page (Start a new request) and fills it in; fields marked * are required. Signs in the signature box if the form has one. On some forms, chooses who approves first in the Send to box. Chooses Submit for approval. If anything is missing or wrong, the fields are highlighted and nothing is sent.',
    '-'],
  [2, 'Request created', 'System',
    'Gives the request its number (for example REQ-000123) and the status In progress, saves exactly what was submitted, and makes step 1 active. The requester sees the request page with its progress tracker.',
    'Requester: "We received your request"'],
  [3, 'Approver emailed', 'System',
    'Emails the step\'s approver (and any delegate) a personal link that works only for their account and expires after 14 days. The email lists the request details (up to 12 fields, unless the organisation turned this off) and has Approve, Send back and Reject buttons. Reminders and escalation follow the step\'s rules while it waits.',
    'Approver: "Approval needed"; later "Reminder" if set up'],
  [4, 'Review the request', 'Approver',
    'Signs in (from the email or the home page list "Waiting for my approval"). Sees the full submission, every earlier step\'s decision, comments, signature and documents, and any earlier send-backs. Never sees later steps. Nothing can be edited.',
    '-'],
  [5, 'Decision', 'Approver',
    'Chooses one of three: Approve (go to 6), Send back for changes (go to 9) or Reject (go to 10). A button pressed in the email opens the page ready for that choice; the approver still confirms on the page.',
    '-'],
  [6, 'Sign and approve', 'Approver',
    'Draws a signature (required to approve). May add comments and attach documents. If the step asks for it, chooses who approves the next step. The decision, time and signature are recorded and can no longer be changed.',
    '-'],
  [7, 'Last step?', 'System',
    'No: the next step becomes active and its approver is emailed (back to 3 for that approver). Yes: the request is fully approved (go to 8).',
    'Next approver: "Approval needed"'],
  [8, 'APPROVED - final', 'System',
    'Status Approved; nothing can change it. A signed PDF (submission, every decision and signature, any send-backs, audit summary) is created within a minute and archived. The requester and the approvers can download it.',
    'Requester: "Your request is fully approved"'],
  [9, 'Make the changes and resubmit', 'Requester',
    'The approver wrote what needs to change (required). The request stays In progress, marked Sent back. The requester chooses Make the changes: the form opens pre-filled with the approver\'s message on top; drawn signatures must be made again; a note can be added. Resubmit sends it straight back to the same step (back to 3). Earlier approvals stay approved. Can happen more than once.',
    'Requester: "Changes needed"; approver on resubmit: "Resubmitted for approval" with what changed'],
  [10, 'REJECTED - final', 'System',
    'The approver gave a reason (required). The request stops: later steps are marked Not reached, and it can never be reopened. A PDF marked REJECTED is archived. To try again, the requester starts a new request using the same details.',
    'Requester: "Your request was rejected" with the reason; administrators: alert'],
];

const TX = M, TW = W - 2 * M;
const colW = [26, 128, 66, TW - 26 - 128 - 66 - 176, 176];
const heads = ['#', 'Step', 'Who', 'What happens', 'Emails sent'];
let ty = 76;
const PAD = 5;
// header row
doc.rect(TX, ty, TW, 18).fill(C.ink);
let hx = TX;
heads.forEach((h, i) => { doc.font(FONT.b).fontSize(8.5).fillColor('#ffffff').text(h, hx + PAD, ty + 5, { width: colW[i] - 2 * PAD }); hx += colW[i]; });
ty += 18;

steps.forEach(([n, title, who, what, mails], i) => {
  doc.font(FONT.r).fontSize(7.6);
  const h = Math.max(
    doc.heightOfString(what, { width: colW[3] - 2 * PAD, lineGap: 0.5 }),
    doc.heightOfString(mails, { width: colW[4] - 2 * PAD }),
    doc.font(FONT.b).fontSize(8.4).heightOfString(title, { width: colW[1] - 2 * PAD }),
  ) + 2 * PAD + 1;
  if (i % 2) doc.rect(TX, ty, TW, h).fill(C.soft);
  const tone = n === 8 ? C.ok : n === 10 ? C.bad : n === 9 ? C.back : C.ink;
  num(n, TX + 13, ty + PAD + 6);
  let x = TX + colW[0];
  doc.font(FONT.b).fontSize(8.4).fillColor(tone).text(title, x + PAD, ty + PAD, { width: colW[1] - 2 * PAD }); x += colW[1];
  doc.font(FONT.b).fontSize(7.6);
  const ww = doc.widthOfString(who) + 10;
  doc.roundedRect(x + PAD, ty + PAD - 1, ww, 12, 6).fill(WHO[who]);
  doc.fillColor('#ffffff').text(who, x + PAD, ty + PAD + 1.6, { width: ww, align: 'center' }); x += colW[2];
  doc.font(FONT.r).fontSize(7.6).fillColor(C.text).text(what, x + PAD, ty + PAD, { width: colW[3] - 2 * PAD, lineGap: 0.5 }); x += colW[3];
  doc.font(FONT.r).fontSize(7.6).fillColor(C.muted).text(mails, x + PAD, ty + PAD, { width: colW[4] - 2 * PAD });
  ty += h;
  doc.moveTo(TX, ty).lineTo(TX + TW, ty).lineWidth(0.5).strokeColor(C.rule).stroke();
});

// administrators, at any point while the request is open
ty += 10;
doc.rect(TX, ty, 3, 40).fill(C.warn);
doc.font(FONT.b).fontSize(9).fillColor(C.text).text('At any time while a request is open - administrators', TX + 10, ty + 1, { width: TW - 12 });
doc.font(FONT.r).fontSize(7.8).fillColor(C.muted).text(
  'Send reminder (a fresh link to the current approver)  -  Reassign a step to someone else, or add a delegate who can act too  -  Cancel the request with a reason (final, the requester is emailed, no PDF). ' +
  'Every submission, decision, email, download and change is recorded in the audit log with the user and time.',
  TX + 10, ty + 15, { width: TW - 12, lineGap: 1 });

// ---- footer on both pages ----
for (let i = 0; i < 2; i++) {
  doc.switchToPage(i);
  doc.font(FONT.r).fontSize(7.5).fillColor(C.muted)
    .text(`ApprovalFlow  |  Request workflow  |  Page ${i + 1} of 2`, M, H - 24, { width: W - 2 * M, align: 'center', lineBreak: false });
}

doc.end();
console.log(`Wrote ${OUT}`);
