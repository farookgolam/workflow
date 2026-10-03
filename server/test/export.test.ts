import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processArchive } from '../src/archive/worker';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { app, bearer, login, makePlatformAdmin, makeTenant, makeUser, platformLogin } from './helpers';

// Exporting a customer's PDFs as one ZIP with an Excel index, by its administrators and by global administrators.
const api = '/api/v1';
const SIG = { strokes: [[10, 10, 90, 40]] };
let t: { tenantId: number; slug: string };
let other: { tenantId: number; slug: string };
let formId: number;
let otherFormId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};
let globalTok: string;

const today = new Date();
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dmy = (d: Date) => `${String(d.getDate()).padStart(2, '0')}${String(d.getMonth() + 1).padStart(2, '0')}${d.getFullYear()}`;
const range = { from: ymd(new Date(today.getTime() - 86_400_000)), to: ymd(today) };

async function closed(title: string, hours: number, outcome: 'approve' | 'reject') {
  const res = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { title, hours, urgent: true } });
  const [s] = await tenantQuery<{ RequestStepId: number }>(t.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R', { R: res.body.requestId });
  await request(app).post(`${api}/approvals/${s.RequestStepId}/decision`).set(bearer(tok.ann))
    .send(outcome === 'approve' ? { decision: 'approve', signature: SIG } : { decision: 'reject', rejectionReason: 'Too many hours' });
  return res.body.requestNumber as string;
}
// the audit entry is written just after the download has been sent
async function lastExportAudit() {
  for (let i = 0; i < 20; i++) {
    const [a] = await tenantQuery<{ AuditId: number; DetailJson: string }>(t.tenantId, `SELECT TOP 1 AuditId, DetailJson FROM AuditLog WHERE TenantId = @TenantId AND Action = 'pdf.exported' ORDER BY AuditId DESC`);
    if (a && a.AuditId !== seenAudit) { seenAudit = a.AuditId; return JSON.parse(a.DetailJson); }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no new pdf.exported audit entry');
}
let seenAudit = 0;
// supertest: collect a binary body
const binary = (r: request.Test) => r.buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

beforeAll(async () => {
  t = await makeTenant();
  other = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ann: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@ex.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@ex.test`)).body.accessToken;
  }
  formId = (await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({
    name: 'Timesheet for Teachers', slug: 'timesheet',
    fields: [{ key: 'title', label: 'Week', type: 'text', required: true }, { key: 'hours', label: 'Hours', type: 'number' }, { key: 'urgent', label: 'Urgent', type: 'checkbox' }],
  })).body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Secretary', approverUserId: ids.ann }] });

  const otherAdmin = await makeUser(other.tenantId, 'admin@other.test', ['Admin']);
  const otherTok = (await login(other.slug, 'admin@other.test')).body.accessToken;
  otherFormId = (await request(app).post(`${api}/admin/forms`).set(bearer(otherTok)).send({ name: 'Theirs', slug: 'theirs', fields: [{ key: 'a', label: 'A', type: 'text' }] })).body.formId;
  expect(otherAdmin).toBeGreaterThan(0);

  const g = await makePlatformAdmin();
  globalTok = (await platformLogin(g.email)).body.accessToken;
});
afterAll(closePool);

describe('PDF export', () => {
  it('previews, then downloads a ZIP of the PDFs with an Excel index linking to them', async () => {
    const approved = await closed('Week 40', 38, 'approve');
    const rejected = await closed('Week 41', 60, 'reject');
    // still in progress: not exported
    await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { title: 'Week 42', hours: 40 } });

    const pending = await request(app).get(`${api}/admin/exports/pdfs/preview`).query({ formId, ...range }).set(bearer(tok.admin));
    expect(pending.body).toMatchObject({ form: 'Timesheet for Teachers', pdfs: 0, pending: 2, max: 500 });
    await processArchive({ tenantId: t.tenantId });
    const preview = await request(app).get(`${api}/admin/exports/pdfs/preview`).query({ formId, ...range }).set(bearer(tok.admin));
    const dmyOf = (s: string) => `${s.slice(8, 10)}${s.slice(5, 7)}${s.slice(0, 4)}`;
    expect(preview.body).toMatchObject({ pdfs: 2, pending: 0, fileName: `Timesheet_PDFs_${dmyOf(range.from)}-${dmyOf(range.to)}.zip` });

    const res = await binary(request(app).get(`${api}/admin/exports/pdfs`).query({ formId, ...range }).set(bearer(tok.admin)));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/filename="Timesheet_PDFs_\d{8}-\d{8}\.zip"/);

    const zip = await JSZip.loadAsync(res.body as Buffer);
    const names = Object.keys(zip.files).sort();
    const num = (n: string) => n.replace('REQ-', '');
    expect(names).toEqual([`Timesheet_${num(approved)}_${dmy(today)}.pdf`, `Timesheet_${num(rejected)}_${dmy(today)}.pdf`, 'Index.xlsx'].sort());
    expect((await zip.file(names.find((n) => n.endsWith('.pdf'))!)!.async('nodebuffer')).subarray(0, 5).toString()).toBe('%PDF-');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await zip.file('Index.xlsx')!.async('nodebuffer'));
    const ws = wb.getWorksheet('Index')!;
    const header = (ws.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual(['File name', 'Request', 'Form', 'Status', 'Submitted by', 'Submitted', 'Decided', 'Approval steps', 'Rejection reason', 'Week', 'Hours', 'Urgent']);
    const rows = [2, 3].map((i) => (ws.getRow(i).values as unknown[]).slice(1));
    const byNumber = Object.fromEntries(rows.map((r) => [r[1], r]));
    expect(byNumber[approved][0]).toMatchObject({ text: `Timesheet_${num(approved)}_${dmy(today)}.pdf`, hyperlink: `Timesheet_${num(approved)}_${dmy(today)}.pdf` });
    expect(byNumber[approved].slice(2, 5)).toEqual(['Timesheet for Teachers', 'Approved', 'SAM']);
    expect(byNumber[approved][7]).toMatch(/^Secretary: ANN - approved \d{2}\/\d{2}\/\d{4}$/);
    expect(byNumber[approved].slice(9)).toEqual(['Week 40', 38, 'Yes']);
    expect(byNumber[rejected][3]).toBe('Rejected');
    expect(byNumber[rejected][8]).toBe('Too many hours');

    expect(await lastExportAudit()).toMatchObject({ formId, files: 2, status: 'Both' });
  });

  it('filters by outcome, and refuses empty, backwards, foreign or too-large requests with a clear message', async () => {
    const only = await request(app).get(`${api}/admin/exports/pdfs/preview`).query({ formId, ...range, status: 'Rejected' }).set(bearer(tok.admin));
    expect(only.body.pdfs).toBe(1);
    const empty = await request(app).get(`${api}/admin/exports/pdfs`).query({ formId, from: '2020-01-01', to: '2020-01-31' }).set(bearer(tok.admin));
    expect(empty.status).toBe(404);
    expect(empty.body.error.code).toBe('nothing_to_export');
    expect((await request(app).get(`${api}/admin/exports/pdfs/preview`).query({ formId, from: range.to, to: '2020-01-01' }).set(bearer(tok.admin))).status).toBe(400);
    expect((await request(app).get(`${api}/admin/exports/pdfs/preview`).query({ formId: otherFormId, ...range }).set(bearer(tok.admin))).status).toBe(404); // another customer's form
    expect((await request(app).get(`${api}/admin/exports/pdfs/preview`).query({ formId, ...range }).set(bearer(tok.sam))).status).toBe(403); // not an administrator
  });

  it('a global administrator can export any customer, and both audit logs record it', async () => {
    const forms = await request(app).get(`${api}/global/tenants/${t.tenantId}/forms`).set(bearer(globalTok));
    expect(forms.body.forms).toContainEqual({ formId, name: 'Timesheet for Teachers', deleted: false });
    const res = await binary(request(app).get(`${api}/global/tenants/${t.tenantId}/exports/pdfs`).query({ formId, ...range, status: 'Approved' }).set(bearer(globalTok)));
    expect(res.status).toBe(200);
    expect(Object.keys((await JSZip.loadAsync(res.body as Buffer)).files)).toHaveLength(2); // one PDF + Index.xlsx
    expect(await lastExportAudit()).toMatchObject({ files: 1, status: 'Approved', changedBy: expect.stringContaining('@') });
    expect((await request(app).get(`${api}/global/tenants/${t.tenantId}/forms`).set(bearer(tok.admin))).status).toBe(401); // a customer's token is not a global one
  });

  it('the console\'s customer list says how much room each customer\'s files take, and how many active administrators it has', async () => {
    const list = (await request(app).get(`${api}/global/tenants`).set(bearer(globalTok))).body.tenants as { tenantId: number; storageBytes: number; counts: { users: number; admins: number } }[];
    const mine = list.find((x) => x.tenantId === t.tenantId)!;
    // exactly the recorded sizes of its stored PDFs (it has no approver documents) - and nobody else's
    const [{ Bytes, Files }] = await tenantQuery<{ Bytes: string; Files: number }>(t.tenantId, 'SELECT SUM(CAST(SizeBytes AS BIGINT)) AS Bytes, COUNT(*) AS Files FROM RequestDocuments WHERE TenantId = @TenantId');
    expect(Files).toBeGreaterThan(0);
    expect(mine.storageBytes).toBe(Number(Bytes));
    expect(mine.storageBytes).toBeGreaterThan(1000);
    expect(list.find((x) => x.tenantId === other.tenantId)!.storageBytes).toBe(0); // the other customer closed nothing
    // a deactivated administrator is not counted
    expect(mine.counts.admins).toBe(1);
    await tenantQuery(t.tenantId, 'UPDATE Users SET IsActive = 0 WHERE TenantId = @TenantId AND UserId = @U', { U: ids.admin });
    const again = (await request(app).get(`${api}/global/tenants/${t.tenantId}`).set(bearer(globalTok))).body.tenant;
    expect(again.counts.admins).toBe(0);
    expect(again.storageBytes).toBe(mine.storageBytes);
  });
});
