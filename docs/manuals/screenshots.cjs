// Screenshots for the manuals, taken from the LOCAL dev copy with demo data only - never from a live server.
//   1. start the dev servers (API on 4200, web on 5173)
//   2. node docs/manuals/screenshots.cjs            (all)   or   node docs/manuals/screenshots.cjs user-14 user-16   (some)
// It prepares a demo organisation "Riverside Academy" (address riverside.approvalflow.localhost) the first time:
// created through the local global console (test global admin qa-global@demo.test), people and the Purchase Request
// form from seed-demo.ts, then requests in every state through the API. Later runs reuse it, so pictures stay the
// same. Each shot signs in as a demo person in Microsoft Edge (already installed - nothing is downloaded), opens a
// screen, outlines the element a step talks about, and saves docs/manuals/screens/<name>.jpg.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const serverRequire = createRequire(path.join(__dirname, '..', '..', 'server', 'package.json'));
const puppeteer = serverRequire('puppeteer-core');

const API = 'http://localhost:4200/api/v1';
const SLUG = 'riverside';
const SITE = `http://${SLUG}.approvalflow.localhost:5173`;
const KEY = process.env.SEED_DEMO_KEY || '482615'; // the demo key from seed-demo.ts - local demo accounts only
const OUT = path.join(__dirname, 'screens');
const EDGE = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const SIG = { strokes: [[40, 120, 70, 60, 110, 130, 150, 50, 200, 120, 240, 80, 300, 110]] };

// ------------------------------------------------------------------------------------------------
// API helpers (the demo data)
// ------------------------------------------------------------------------------------------------
async function call(method, url, token, body, retry = 2) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(async (e) => { // a kept-alive connection the API has already closed: try again on a new one
    if (!retry) throw e;
    await new Promise((r) => setTimeout(r, 500));
    return call(method, url, token, body, retry - 1).then((json) => ({ ok: true, text: async () => JSON.stringify(json) }));
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}
const login = async (who) => (await call('POST', '/auth/login', null, { email: `${who}@${SLUG}.test`, password: KEY, tenantSlug: SLUG })).accessToken;

async function prepare() {
  const g = (await call('POST', '/global/auth/login', null, { email: 'qa-global@demo.test', password: KEY })).accessToken;
  const tenants = (await call('GET', '/global/tenants', g)).tenants;
  if (!tenants.some((t) => t.slug === SLUG)) {
    await call('POST', '/global/tenants', g, { name: 'Riverside Academy', slug: SLUG, adminEmail: `admin@${SLUG}.test`, adminDisplayName: 'Alex Admin', adminKey: KEY });
    console.log('created Riverside Academy');
  }
  const npm = (...args) => execFileSync('npm', ['run', '--silent', ...args], { cwd: path.join(__dirname, '..', '..', 'server'), stdio: 'inherit', shell: true });
  npm('seed:demo', '--', '--slug', SLUG);
  npm('sample:lookups', '--', '--import', '--tenant', SLUG); // Schools, Departments, Job descriptions (skipped when there)
  npm('sample:forms', '--', '--tenant', SLUG); // the five sample forms (left alone when there)

  const sam = await login('submitter');
  if ((await call('GET', '/my/requests', sam)).total > 0) return loadIds(sam); // already prepared
  const forms = (await call('GET', '/forms', sam)).forms;
  const formId = forms.find((f) => f.slug === 'purchase-request').formId;
  const submit = (title, justification, amount, category, urgent = false) =>
    call('POST', `/forms/${formId}/requests`, sam, { values: { title, justification, amount, category, urgent } });
  const tok = { manager: await login('manager'), finance: await login('finance'), director: await login('director') };
  const stepFor = async (who, number) => (await call('GET', '/approvals/pending', tok[who])).approvals.find((a) => a.requestNumber === number).requestStepId;
  const approve = async (who, number, comments) => call('POST', `/approvals/${await stepFor(who, number)}/decision`, tok[who], { decision: 'approve', signature: SIG, comments });

  const a = (await submit('Laptop for a new teacher', 'Ms Rivera starts on Monday and needs a laptop for lesson planning.', 1249, 'Hardware')).requestNumber;
  await approve('manager', a, 'Agreed - she starts next week.');
  await approve('finance', a);
  await approve('director', a);
  const b = (await submit('Conference trip to Chicago', 'National science teaching conference, 3 days including travel and hotel.', 1850, 'Services')).requestNumber;
  await approve('manager', b);
  await call('POST', `/approvals/${await stepFor('finance', b)}/decision`, tok.finance, { decision: 'reject', rejectionReason: 'Not in this year\'s training budget. Please apply again in the spring.' });
  const c = (await submit('Ergonomic desk chair', 'For the front office - the current chair is broken.', 420, 'Hardware')).requestNumber;
  await call('POST', `/approvals/${await stepFor('manager', c)}/decision`, tok.manager, { decision: 'return', returnReason: 'Please add the supplier\'s quote number to the justification.' });
  await submit('Projector for room 12', 'The old projector no longer turns on; lessons in room 12 rely on it.', 689, 'Hardware', true);
  await submit('Science lab supplies', 'Beakers, safety goggles and test tubes for the autumn term.', 312.5, 'Other');
  const f = (await submit('Office software licences', 'Renewal of 8 office software licences for the admin team.', 960, 'Software')).requestNumber;
  await approve('manager', f, 'Same as last year.');
  console.log('demo requests created');
  await new Promise((r) => setTimeout(r, 20000)); // the archive worker makes the approved and rejected PDFs
  return loadIds(sam);
}

/** Request ids are numbered across all organisations: look Riverside's up by request number. */
const ID = {};
async function loadIds(sam) {
  for (const r of (await call('GET', '/my/requests', sam)).requests) ID[r.requestNumber] = r.requestId;
}

// ------------------------------------------------------------------------------------------------
// Browser helpers
// ------------------------------------------------------------------------------------------------
const HIGHLIGHT_CSS = '[data-hl]{outline:3px solid #e11d48 !important;outline-offset:3px;border-radius:4px}';

// one browser profile per person, signed in once: the app limits sign-ins per minute, and later pages of the same
// person reuse the session cookie
const contexts = new Map();
async function signedIn(browser, who, width = who === 'admin' ? 1280 : 1100) {
  const known = who && contexts.get(who);
  const ctx = known ?? (await browser.createBrowserContext());
  if (who) contexts.set(who, ctx);
  const page = await ctx.newPage();
  await page.setViewport({ width, height: 760, deviceScaleFactor: 2 }); // the admin menu needs 1280 to stay on one line
  if (known) {
    await page.goto(`${SITE}/`, { waitUntil: 'networkidle0' });
    if (!new URL(page.url()).pathname.startsWith('/login')) return page;
  }
  if (who) {
    await page.goto(`${SITE}/login`, { waitUntil: 'networkidle0' });
    await page.type('input[type=email]', `${who}@${SLUG}.test`);
    await page.keyboard.press('Enter');
    await page.waitForSelector('input[type=password]');
    await page.type('input[type=password]', KEY);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !location.pathname.startsWith('/login'));
    await page.waitForNetworkIdle();
  }
  return page;
}
async function go(page, url) {
  await page.goto(`${SITE}${url}`, { waitUntil: 'networkidle0' });
  await page.addStyleTag({ content: HIGHLIGHT_CSS });
}
// The global console (http://localhost:5173/global) - its own sign-in, kept in one browser profile. It keeps a
// request open in the background, so pages are taken as loaded when at most two are still running.
const CONSOLE = 'http://localhost:5173/global';
let consoleCtx;
async function gGo(page, url) {
  await page.goto(`${CONSOLE}${url}`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('h1'); await new Promise((r) => setTimeout(r, 500));
  await page.addStyleTag({ content: HIGHLIGHT_CSS });
}
async function console_(browser, signIn = true) {
  if (!signIn) {
    const page = await (await browser.createBrowserContext()).newPage();
    await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 2 });
    return page;
  }
  const first = !consoleCtx;
  consoleCtx ??= await browser.createBrowserContext();
  const page = await consoleCtx.newPage();
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 2 });
  if (first) {
    await gGo(page, '/');
    await page.type('#email', 'qa-global@demo.test'); await page.type('input[type=password]', KEY); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.body.textContent.includes('New customer'), { timeout: 30000 }); // signed in
  }
  return page;
}
async function riverside(browser) {
  const p = await console_(browser); await gGo(p, '/');
  await clickText(p, 'a', 'Riverside Academy', 2); await p.waitForSelector('#cname'); await p.addStyleTag({ content: HIGHLIGHT_CSS });
  return p;
}

/** Outlines the first element matching `selector` whose text includes `text` (any matching element when no text). */
async function highlight(page, selector, text) {
  const ok = await page.evaluate((sel, txt) => {
    const el = [...document.querySelectorAll(sel)].find((e) => !txt || e.textContent.includes(txt));
    if (el) el.setAttribute('data-hl', '');
    return !!el;
  }, selector, text ?? null);
  if (!ok) throw new Error(`nothing to highlight: ${selector} "${text}"`);
}
async function clickText(page, selector, text, busy = 0) {
  const ok = await page.evaluate((sel, txt) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(txt));
    if (el) el.click();
    return !!el;
  }, selector, text);
  if (!ok) throw new Error(`nothing to click: ${selector} "${text}"`);
  await page.waitForNetworkIdle({ concurrency: busy }); // the global console always has a request open: busy 2
}
/** The box around the first `selector` whose text includes `text`, plus a margin - or the whole page area shown. */
async function clipOf(page, selector, text, pad = 12) {
  const box = await page.evaluate((sel, txt) => {
    const el = [...document.querySelectorAll(sel)].find((e) => !txt || e.textContent.includes(txt));
    if (!el) return null;
    el.scrollIntoView({ block: 'start' });
    const r = el.getBoundingClientRect();
    return { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
  }, selector, text ?? null);
  if (!box) throw new Error(`nothing to frame: ${selector} "${text}"`);
  return { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: Math.min(box.height + 2 * pad, 1400) };
}
async function save(page, name, clip) {
  await page.evaluate(() => document.activeElement?.blur?.()); // no focus glow that could pass for a highlight
  await new Promise((r) => setTimeout(r, 300)); // let the last paint settle
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 82, ...(clip ? { clip, captureBeyondViewport: true } : {}) });
  console.log(`  ${name}.jpg`);
}
async function drawSignature(page) {
  const pad = await page.$('.sigpad svg'); // the signature pad (client/src/sigpad.tsx), drawn with pointer events
  await pad.evaluate((e) => e.scrollIntoView({ block: 'center' }));
  const b = await pad.boundingBox();
  const pts = [[0.1, 0.6], [0.2, 0.3], [0.3, 0.65], [0.42, 0.25], [0.55, 0.6], [0.68, 0.35], [0.85, 0.55]];
  await page.mouse.move(b.x + b.width * pts[0][0], b.y + b.height * pts[0][1]);
  await page.mouse.down();
  for (const [x, y] of pts.slice(1)) await page.mouse.move(b.x + b.width * x, b.y + b.height * y, { steps: 6 });
  await page.mouse.up();
}
/** A stored email, laid out as it arrives (the same layout as server/src/notifications/mailer.ts). */
function emailHtml(type, requestNumber, to) {
  const q = (col) => execFileSync('sqlcmd', ['-S', '.', '-E', '-d', 'ApprovalFlow_Dev', '-y', '0', '-Q',
    `SET NOCOUNT ON; SELECT TOP 1 n.${col} FROM Notifications n JOIN Tenants t ON t.TenantId = n.TenantId JOIN Requests r ON r.TenantId = n.TenantId AND r.RequestId = n.RequestId
      WHERE t.Slug = '${SLUG}' AND n.Type = '${type}' AND r.RequestNumber = '${requestNumber}' AND n.RecipientEmail = '${to}' ORDER BY n.NotificationId DESC`], { encoding: 'utf8' }).trim();
  const subject = q('Subject');
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Segoe UI,Arial,sans-serif;color:#1f2937">
<div style="max-width:600px;margin:24px auto;background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:24px 28px">
<h2 style="margin:0 0 16px;font-size:18px">${subject}</h2>${q('BodyHtml')}
<p style="margin-top:24px;font-size:12px;color:#6b7280">This is an automated message from FileBank WorkFlow. Please do not reply.</p></div></body></html>`;
}

// ------------------------------------------------------------------------------------------------
// The User Manual's screenshots
// ------------------------------------------------------------------------------------------------
const SHOTS = {
  async 'user-01-sign-in'(b) {
    const p = await signedIn(b, null); await go(p, '/login');
    await highlight(p, 'input[type=email]'); await save(p, 'user-01-sign-in');
  },
  async 'user-02-key'(b) {
    const p = await signedIn(b, null); await go(p, '/login');
    await p.type('input[type=email]', `submitter@${SLUG}.test`); await p.keyboard.press('Enter'); await p.waitForSelector('input[type=password]');
    await p.addStyleTag({ content: HIGHLIGHT_CSS }); await highlight(p, 'input[type=password]'); await save(p, 'user-02-key');
  },
  async 'user-03-first-time'(b) {
    const p = await signedIn(b, null); await go(p, '/login');
    await p.type('input[type=email]', `new.teacher@${SLUG}.test`); await p.keyboard.press('Enter');
    await p.waitForFunction(() => document.body.textContent.includes('Create your password key'));
    await save(p, 'user-03-first-time');
  },
  async 'user-04-home'(b) {
    const p = await signedIn(b, 'submitter'); await go(p, '/');
    await highlight(p, '.form-card', 'Purchase Request'); await save(p, 'user-04-home');
  },
  async 'user-05-help'(b) {
    const p = await signedIn(b, 'submitter'); await go(p, '/');
    await clickText(p, 'summary', 'Help'); await highlight(p, '.help-pop a', 'workflow');
    await save(p, 'user-05-help', { x: 500, y: 0, width: 600, height: 230 });
  },
  async 'user-06-new-request'(b) {
    const p = await signedIn(b, 'submitter'); await go(p, '/');
    await clickText(p, '.form-card', 'Purchase Request'); await p.addStyleTag({ content: HIGHLIGHT_CSS });
    const fill = async (sel, v) => { await p.click(sel, { count: 3 }); await p.type(sel, v); };
    await fill('#f-title', 'Whiteboard markers'); await fill('#f-justification', 'Two boxes for the maths department.');
    await fill('#f-amount', '45.80'); await p.select('#f-category', 'Other');
    await highlight(p, 'button', 'Submit for approval'); await save(p, 'user-06-new-request');
  },
  async 'user-07-my-submissions'(b) {
    const p = await signedIn(b, 'submitter'); await go(p, '/');
    await save(p, 'user-07-my-submissions', await clipOf(p, 'section.card', 'My submissions'));
  },
  async 'user-08-progress'(b) {
    const p = await signedIn(b, 'submitter'); await go(p, `/requests/${ID['REQ-000006']}`);
    await save(p, 'user-08-progress', await clipOf(p, 'section.card', 'Progress'));
  },
  async 'user-09-sent-back'(b) {
    const p = await signedIn(b, 'submitter'); await go(p, `/requests/${ID['REQ-000003']}`);
    await highlight(p, 'a.button', 'Make the changes'); await save(p, 'user-09-sent-back', await clipOf(p, '.notice.back'));
  },
  async 'user-10-resubmit'(b) {
    const p = await signedIn(b, 'submitter'); await go(p, `/requests/${ID['REQ-000003']}/edit`);
    await highlight(p, 'button', 'Resubmit'); await save(p, 'user-10-resubmit');
  },
  async 'user-11-rejected'(b) {
    const p = await signedIn(b, 'submitter'); await go(p, `/requests/${ID['REQ-000002']}`);
    await save(p, 'user-11-rejected', await clipOf(p, '.notice.bad'));
  },
  async 'user-12-pdf'(b) {
    const p = await signedIn(b, 'submitter'); await go(p, `/requests/${ID['REQ-000001']}`);
    await highlight(p, 'button', 'final PDF'); await save(p, 'user-12-pdf');
  },
  async 'user-13-email'(b) {
    const p = await signedIn(b, null);
    await p.setContent(emailHtml('ApprovalRequested', 'REQ-000004', `manager@${SLUG}.test`), { waitUntil: 'load' });
    await save(p, 'user-13-email', await clipOf(p, 'body > div', null, 8));
  },
  async 'user-14-waiting'(b) {
    const p = await signedIn(b, 'manager'); await go(p, '/');
    await save(p, 'user-14-waiting', await clipOf(p, 'section.card', 'Waiting for my approval'));
  },
  async 'user-15-approval-page'(b) {
    const p = await signedIn(b, 'manager'); await go(p, '/');
    await clickText(p, 'a', 'REQ-000004'); await p.addStyleTag({ content: HIGHLIGHT_CSS });
    await save(p, 'user-15-approval-page');
  },
  async 'user-16-approve'(b) {
    const p = await signedIn(b, 'manager'); await go(p, '/');
    await clickText(p, 'a', 'REQ-000004'); await p.addStyleTag({ content: HIGHLIGHT_CSS });
    await p.type('#comments', 'Urgent - approved.');
    await drawSignature(p);
    await highlight(p, 'button.primary', 'Approve');
    await save(p, 'user-16-approve', await clipOf(p, 'section.card', 'Your section'));
  },
  async 'user-17-send-back'(b) {
    const p = await signedIn(b, 'manager'); await go(p, '/');
    await clickText(p, 'a', 'REQ-000004'); await p.addStyleTag({ content: HIGHLIGHT_CSS });
    await clickText(p, '.seg button', 'Send back'); await p.type('#return-reason', 'Please say which room the old projector can be collected from.');
    await highlight(p, 'button', 'Send back to'); await save(p, 'user-17-send-back', await clipOf(p, 'section.card', 'Your section'));
  },
  async 'user-18-reject'(b) {
    const p = await signedIn(b, 'manager'); await go(p, '/');
    await clickText(p, 'a', 'REQ-000004'); await p.addStyleTag({ content: HIGHLIGHT_CSS });
    await clickText(p, '.seg button', 'Reject'); await p.type('#reason', 'We are replacing all projectors next year.');
    await highlight(p, 'button', 'Confirm rejection'); await save(p, 'user-18-reject', await clipOf(p, 'section.card', 'Your section'));
  },
  async 'user-19-batch'(b) {
    const p = await signedIn(b, 'manager'); await go(p, '/');
    await p.click('input[aria-label="Select all"]'); await highlight(p, 'button', 'Approve selected');
    await save(p, 'user-19-batch', await clipOf(p, 'section.card', 'Waiting for my approval'));
    await p.evaluate(() => document.querySelectorAll('[data-hl]').forEach((e) => e.removeAttribute('data-hl')));
    await clickText(p, 'button', 'Approve selected'); await drawSignature(p);
    await highlight(p, 'button.primary', 'Approve 2 requests');
    await save(p, 'user-20-batch-panel', await clipOf(p, '.batch-box'));
  },
  async 'user-21-previous'(b) {
    const p = await signedIn(b, 'finance'); await go(p, '/');
    await clickText(p, 'a', 'REQ-000006');
    await save(p, 'user-21-previous', await clipOf(p, 'section.card', 'Previous approvals'));
  },
  async 'user-22-account'(b) {
    const p = await signedIn(b, 'manager'); await go(p, '/account');
    await clickText(p, 'label', 'Send me one summary'); // shows the time box; switched back below
    await highlight(p, '#digest-hour'); await save(p, 'user-22-account', await clipOf(p, 'section.card', 'Approval emails'));
    await clickText(p, 'label', 'Email me about each request');
  },

  // ----------------------------------------------------------------------------------------------
  // The Administrator Manual's screenshots (Alex Admin, at 1280 wide)
  // ----------------------------------------------------------------------------------------------
  async 'admin-01-dashboard'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin');
    await highlight(p, '.tiles'); await save(p, 'admin-01-dashboard', { x: 0, y: 0, width: 1280, height: 560 });
  },
  async 'admin-02-help'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin');
    await clickText(p, 'summary', 'Help'); await highlight(p, '.help-pop a', 'Administrator Manual');
    await save(p, 'admin-02-help', { x: 680, y: 0, width: 600, height: 230 });
  },
  async 'admin-03-requests'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/requests');
    await highlight(p, '.card.filters'); await save(p, 'admin-03-requests');
  },
  async 'admin-04-request-actions'(b) {
    const p = await signedIn(b, 'admin'); await go(p, `/admin/requests/${ID['REQ-000005']}`);
    await highlight(p, 'button', 'Send reminder');
    const top = await clipOf(p, 'section.card', 'Timeline', 0);
    await save(p, 'admin-04-request-actions', { x: 80, y: 70, width: 1120, height: top.y + 330 - 70 });
  },
  async 'admin-05-reassign'(b) {
    const p = await signedIn(b, 'admin'); await go(p, `/admin/requests/${ID['REQ-000005']}`);
    await clickText(p, 'button', 'Reassign'); await p.select('select[aria-label="New approver"]', (await p.$$eval('select[aria-label="New approver"] option', (o) => o.find((x) => x.textContent.includes('Dana'))?.value)));
    await highlight(p, 'label.check', 'As delegate');
    await save(p, 'admin-05-reassign', await clipOf(p, 'section.card', 'Timeline'));
  },
  async 'admin-06-cancel'(b) {
    const p = await signedIn(b, 'admin'); await go(p, `/admin/requests/${ID['REQ-000005']}`);
    await clickText(p, 'button', 'Cancel request'); await p.type('section.card textarea', 'Submitted twice - the same order is REQ-000004.');
    await highlight(p, 'button', 'Confirm cancel');
    await save(p, 'admin-06-cancel', await clipOf(p, 'section.card', 'Actions'));
  },
  async 'admin-07-export'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/requests');
    await clickText(p, 'button', 'Export PDFs'); await p.addStyleTag({ content: HIGHLIGHT_CSS });
    const form = await p.$$eval('.filters select option', (o) => o.find((x) => x.textContent === 'Purchase Request')?.value);
    await p.select('.filters label:first-child select', form);
    await clickText(p, 'button', 'Check'); await highlight(p, 'button.primary', 'Download ZIP');
    await save(p, 'admin-07-export', await clipOf(p, 'section.card', 'Download ZIP'));
  },
  async 'admin-08-forms'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/forms');
    await p.type('section.card input', 'Travel Request'); await highlight(p, 'button', 'Create and configure');
    await save(p, 'admin-08-forms');
  },
  async 'admin-09-details'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/forms'); await clickText(p, 'a', 'Purchase Request');
    await save(p, 'admin-09-details', await clipOf(p, 'section.card', 'Save details'));
  },
  async 'admin-10-builder'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/forms'); await clickText(p, 'a', 'Purchase Request');
    await p.addStyleTag({ content: HIGHLIGHT_CSS }); await highlight(p, '.b-palette');
    await save(p, 'admin-10-builder', await clipOf(p, 'section.card', 'Save fields'));
  },
  async 'admin-11-properties'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/forms'); await clickText(p, 'a', 'Purchase Request');
    await p.addStyleTag({ content: HIGHLIGHT_CSS });
    await (await p.$$('.b-item'))[2].click(); await new Promise((r) => setTimeout(r, 300));
    await highlight(p, '.b-side');
    await save(p, 'admin-11-properties', await clipOf(p, 'section.card', 'Save fields'));
  },
  async 'admin-12-calculated'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/forms'); await clickText(p, 'a', 'Mileage Reimbursement');
    await p.addStyleTag({ content: HIGHLIGHT_CSS });
    const items = await p.$$('.b-item'); for (const it of items) if ((await it.evaluate((e) => e.textContent)).includes('Total claim')) { await it.click(); break; }
    await new Promise((r) => setTimeout(r, 300)); await highlight(p, '.b-side textarea, .b-side input.mono, .b-side [id*=formula]');
    await save(p, 'admin-12-calculated', await clipOf(p, 'section.card', 'Save fields'));
  },
  async 'admin-13-grid'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/forms'); await clickText(p, 'a', 'Mileage Reimbursement');
    await p.addStyleTag({ content: HIGHLIGHT_CSS });
    const items = await p.$$('.b-item'); for (const it of items) if ((await it.evaluate((e) => !!e.querySelector('.gridf')))) { await it.click(); break; }
    await new Promise((r) => setTimeout(r, 300)); await highlight(p, '.b-side');
    await save(p, 'admin-13-grid', await clipOf(p, 'section.card', 'Save fields'));
  },
  async 'admin-14-chain'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/forms'); await clickText(p, 'a', 'Mileage Reimbursement');
    await p.addStyleTag({ content: HIGHLIGHT_CSS }); await highlight(p, 'fieldset', 'Who approves this step');
    await save(p, 'admin-14-chain', await clipOf(p, '.step-def'));
  },
  async 'admin-15-publish'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/forms'); await clickText(p, 'a', 'Mileage Reimbursement');
    await p.addStyleTag({ content: HIGHLIGHT_CSS }); await highlight(p, 'button', 'Publish chain');
    const c = await clipOf(p, 'button', 'Publish chain', 0);
    await save(p, 'admin-15-publish', { x: 80, y: c.y - 420, width: 1120, height: 480 });
  },
  async 'admin-16-chain-preview'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/forms'); await clickText(p, 'a', 'Purchase Request');
    await p.addStyleTag({ content: HIGHLIGHT_CSS });
    await p.evaluate(() => [...document.querySelectorAll('section.card')].find((s) => s.textContent.includes('Approval chain')).querySelectorAll('.seg button')[1].click());
    await p.waitForNetworkIdle();
    await save(p, 'admin-16-chain-preview', await clipOf(p, 'section.card', 'Approval chain'));
  },
  async 'admin-17-lookups'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/lookups');
    await highlight(p, '.file-btn'); await save(p, 'admin-17-lookups');
  },
  async 'admin-18-lookup-rows'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/lookups');
    await clickText(p, 'button', 'Schools'); await p.addStyleTag({ content: HIGHLIGHT_CSS });
    await highlight(p, 'button', 'Edit');
    await save(p, 'admin-18-lookup-rows', await clipOf(p, 'section.card', 'Find'));
  },
  async 'admin-19-users'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/users');
    await highlight(p, 'tr', 'Maria Manager'); await save(p, 'admin-19-users', await clipOf(p, 'section.card', 'Joined'));
  },
  async 'admin-20-add-person'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/users');
    const inputs = await p.$$('fieldset input[type=email], fieldset input[type=text], fieldset input:not([type])'); // email, name
    await inputs[0].type(`jo.teacher@${SLUG}.test`); await inputs[1].type('Jo Teacher');
    await clickText(p, 'fieldset label', 'Approver');
    await highlight(p, 'button', 'Add person'); await save(p, 'admin-20-add-person', await clipOf(p, 'section.card', 'Add people'));
  },
  async 'admin-21-report'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/reports');
    await p.waitForFunction(() => [...document.querySelectorAll('#newForm option')].some((o) => o.textContent.includes('Purchase Request')));
    const form = await p.$$eval('#newForm option', (o) => o.find((x) => x.textContent.includes('Purchase Request'))?.value);
    await p.select('#newForm', form); await p.waitForNetworkIdle();
    await clickText(p, 'button', 'Run report'); await p.addStyleTag({ content: HIGHLIGHT_CSS });
    await highlight(p, 'button', 'Export to Excel');
    await save(p, 'admin-21-report', await clipOf(p, 'section.card', 'Export to Excel'));
    const result = await clipOf(p, 'section.card', 'REQ-000001');
    await save(p, 'admin-24-report-result', { ...result, height: Math.min(result.height, 520) });
  },
  async 'admin-22-audit'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/audit');
    await highlight(p, 'button', 'Export CSV'); await save(p, 'admin-22-audit');
  },
  // ----------------------------------------------------------------------------------------------
  // The Global Administrator Manual's screenshots (the local test global admin, in the console at /global)
  // ----------------------------------------------------------------------------------------------
  async 'global-01-sign-in'(b) {
    const p = await console_(b, false); await gGo(p, '/');
    await p.type('#email', 'qa-global@demo.test'); await highlight(p, 'input[type=password]'); await save(p, 'global-01-sign-in');
  },
  async 'global-02-customers'(b) {
    const p = await console_(b); await gGo(p, '/');
    await highlight(p, 'button', 'New customer'); await save(p, 'global-02-customers', { x: 0, y: 0, width: 1280, height: 400 });
  },
  async 'global-03-new-customer'(b) {
    const p = await console_(b); await gGo(p, '/');
    await clickText(p, 'button', 'New customer', 2); await p.addStyleTag({ content: HIGHLIGHT_CSS });
    await p.type('#name', 'Lakeside College'); await p.type('#adminEmail', 'it.manager@lakeside.test'); await p.type('#adminName', 'Lee Jordan');
    await highlight(p, 'button.primary', 'Create'); await save(p, 'global-03-new-customer', await clipOf(p, 'section.card', 'New customer'));
  },
  async 'global-04-address'(b) {
    const p = await riverside(b);
    await highlight(p, 'button.link', 'Suspend this customer'); await save(p, 'global-04-address', await clipOf(p, 'section.card', 'Address and status'));
  },
  async 'global-05-file-storage'(b) {
    const p = await riverside(b);
    await p.type('#cfolder', 'D:\\CustomerFiles\\Riverside'); await highlight(p, 'button', 'Use this folder');
    await save(p, 'global-05-file-storage', await clipOf(p, 'section.card', 'File storage'));
  },
  async 'global-06-administrators'(b) {
    const p = await riverside(b);
    await p.type('#grant', `bursar@${SLUG}.test`); await p.type('#grant-name', 'Bea Bursar'); await highlight(p, 'button', 'Add administrator');
    await save(p, 'global-06-administrators', await clipOf(p, 'section.card', 'Add an administrator'));
  },
  async 'global-07-export'(b) {
    const p = await riverside(b);
    const form = await p.$$eval('.filters select option', (o) => o.find((x) => x.textContent === 'Purchase Request')?.value);
    await p.select('.filters label:first-child select', form);
    await clickText(p, 'button', 'Check', 2); await highlight(p, 'button.primary', 'Download ZIP');
    await save(p, 'global-07-export', await clipOf(p, 'section.card', 'Download ZIP'));
  },
  async 'global-08-support'(b) {
    const p = await riverside(b);
    await p.type('#reason', 'Ticket 4821 - form will not publish'); await highlight(p, 'button', 'Start support session');
    await save(p, 'global-08-support', await clipOf(p, 'section.card', 'Support access'));
  },
  async 'global-11-activity'(b) {
    const p = await console_(b); await gGo(p, '/activity');
    await p.waitForSelector('table'); await highlight(p, '.nav a', 'Activity');
    await save(p, 'global-11-activity', { x: 0, y: 0, width: 1280, height: 520 });
  },
  async 'global-10-about'(b) {
    const p = await console_(b); await gGo(p, '/about');
    await p.waitForSelector('.about-table'); await save(p, 'global-10-about', { x: 0, y: 0, width: 1280, height: 1100 });
  },
  async 'user-23-about'(b) {
    const p = await signedIn(b, 'submitter'); await go(p, '/');
    await clickText(p, 'summary', 'Help'); await highlight(p, '.help-pop a', 'About');
    await save(p, 'user-23-about-menu', { x: 500, y: 0, width: 600, height: 260 });
    await clickText(p, '.help-pop a', 'About'); await p.waitForSelector('dialog.about .about-table');
    await save(p, 'user-24-about', await clipOf(p, 'dialog.about', null, 16));
  },
  async 'global-09-admins'(b) {
    const p = await console_(b); await gGo(p, '/administrators');
    await highlight(p, 'button', 'New global administrator'); await save(p, 'global-09-admins');
  },

  async 'admin-23-settings'(b) {
    const p = await signedIn(b, 'admin'); await go(p, '/admin/settings');
    await save(p, 'admin-23-settings', await clipOf(p, 'section.card', 'Branding'));
  },
};

(async () => {
  if (!EDGE) throw new Error('Microsoft Edge was not found');
  fs.mkdirSync(OUT, { recursive: true });
  await prepare();
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-first-run', '--disable-features=msEdgeSidebarV2'] });
  const wanted = process.argv.slice(2);
  try {
    for (const [name, shot] of Object.entries(SHOTS)) {
      if (wanted.length && !wanted.some((w) => name.startsWith(w))) continue;
      await shot(browser);
      for (const ctx of browser.browserContexts()) for (const pg of await ctx.pages()) await pg.close(); // sessions stay in the context
    }
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
