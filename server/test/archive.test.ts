import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { archiveFileName } from '../src/archive/pdf';
import { backfillPdfFiles, pdfAbsolutePath, processArchive } from '../src/archive/worker';
import { closePool } from '../src/db/pool';
import { tenantQuery, unscopedQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser, recordStepAnswers } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

const decide = (as: string, id: number, body: Record<string, unknown>) =>
  request(app).post(`${api}/approvals/${id}/decision`).set(bearer(tok[as])).send(body);

async function closedRequest(outcome: 'approve' | 'reject') {
  const res = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { title: 'Ünïcode & <tags> "quoted"' } });
  const requestId: number = res.body.requestId;
  const steps = await tenantQuery<{ RequestStepId: number }>(t.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R ORDER BY StepOrder', { R: requestId });
  await decide('ann', steps[0].RequestStepId, { decision: 'approve', comments: 'Looks right' });
  await recordStepAnswers(t.tenantId, steps[0].RequestStepId, [{ key: 'costCode', label: 'Cost code', type: 'text', value: 'CC-1' }]); // an older chain's approver section, still printed
  await decide('bob', steps[1].RequestStepId, outcome === 'approve' ? { decision: 'approve' } : { decision: 'reject', rejectionReason: 'Not this quarter' });
  return requestId;
}
const archiveRow = async (requestId: number) =>
  (await tenantQuery<Record<string, any>>(t.tenantId, 'SELECT Status, ArchiveStatus, PdfLocalPath FROM Requests WHERE TenantId = @TenantId AND RequestId = @R', { R: requestId }))[0];
const storedPdf = async (requestId: number) =>
  (await tenantQuery<{ FileName: string; Content: Buffer; SizeBytes: number; Sha256: Buffer }>(
    t.tenantId, 'SELECT FileName, Content, SizeBytes, Sha256 FROM RequestDocuments WHERE TenantId = @TenantId AND RequestId = @R', { R: requestId },
  ))[0];

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], sue: ['Submitter'], ann: ['Approver'], bob: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@ar.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@ar.test`)).body.accessToken;
  }
  formId = (await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Capex: Request / 2026', slug: 'capex', fields: [{ key: 'title', label: 'Title', type: 'text', required: true }] })).body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({
    steps: [{ name: 'Manager', approverUserId: ids.ann }, { name: 'Finance', approverUserId: ids.bob }],
  });
});
afterAll(closePool);

describe('file naming', () => {
  it('follows [FormName]_[RequestID]_[YYYYMMDD].pdf and the _REJECTED_ variant, with names safe anywhere', () => {
    const base = { formName: 'Capex: Request / 2026', requestNumber: 'REQ-000042', closedAt: new Date('2026-09-20T23:59:00Z') };
    expect(archiveFileName({ ...base, status: 'Approved' })).toBe('Capex-Request-2026_REQ-000042_20260920.pdf');
    expect(archiveFileName({ ...base, status: 'Rejected' })).toBe('Capex-Request-2026_REQ-000042_REJECTED_20260920.pdf');
  });
});

describe('archive pipeline', () => {
  it('approved: one PDF, stored in the database with its fingerprint, nothing on disk', async () => {
    const requestId = await closedRequest('approve');
    expect((await archiveRow(requestId)).ArchiveStatus).toBe('PdfPending');

    expect(await processArchive({ tenantId: t.tenantId })).toEqual({ generated: 1 });
    expect(await archiveRow(requestId)).toMatchObject({ Status: 'Approved', ArchiveStatus: 'Stored', PdfLocalPath: null });

    const doc = await storedPdf(requestId);
    expect(doc.FileName).toMatch(/^Capex-Request-2026_REQ-\d{6}_\d{8}\.pdf$/);
    expect(doc.SizeBytes).toBe(doc.Content.length);
    expect(doc.Sha256.equals(crypto.createHash('sha256').update(doc.Content).digest())).toBe(true);
    expect(doc.Content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(doc.Content.toString('latin1')).toMatch(/\(APPROVED - Capex: Request \/ 2026 REQ-\d{6}\)/);

    // idempotent: nothing left to do
    expect(await processArchive({ tenantId: t.tenantId })).toEqual({ generated: 0 });
    const [logged] = await tenantQuery<{ ToState: string }>(t.tenantId, `SELECT ToState FROM AuditLog WHERE TenantId = @TenantId AND RequestId = @R AND Action = 'archive.pdf_stored'`, { R: requestId });
    expect(logged.ToState).toBe('Stored');
  });

  it('rejected: same routine, REJECTED banner and file name', async () => {
    const requestId = await closedRequest('reject');
    await processArchive({ tenantId: t.tenantId });
    expect(await archiveRow(requestId)).toMatchObject({ Status: 'Rejected', ArchiveStatus: 'Stored' });
    const doc = await storedPdf(requestId);
    expect(doc.FileName).toMatch(/^Capex-Request-2026_REQ-\d{6}_REJECTED_\d{8}\.pdf$/);
    expect(doc.Content.toString('latin1')).toContain('(REJECTED - Capex');
  });

  it('a stored PDF can never be changed or deleted', async () => {
    const requestId = await closedRequest('approve');
    await processArchive({ tenantId: t.tenantId });
    await expect(tenantQuery(t.tenantId, 'DELETE FROM RequestDocuments WHERE TenantId = @TenantId AND RequestId = @R', { R: requestId })).rejects.toThrow(/cannot be changed or deleted/);
    await expect(tenantQuery(t.tenantId, `UPDATE RequestDocuments SET FileName = 'x.pdf' WHERE TenantId = @TenantId AND RequestId = @R`, { R: requestId })).rejects.toThrow(/cannot be changed or deleted/);
    expect(await storedPdf(requestId)).toBeTruthy();
  });

  it('copies PDFs archived before, as files, into the database - unless a file was changed', async () => {
    // two requests archived the old way: a file on disk, its fingerprint on the request
    const make = async () => {
      const requestId = await closedRequest('approve');
      const pdf = Buffer.from(`%PDF-1.4 old archive ${requestId}`);
      const relative = path.join(String(t.tenantId), `old_${requestId}.pdf`);
      fs.mkdirSync(path.dirname(pdfAbsolutePath(relative)), { recursive: true });
      fs.writeFileSync(pdfAbsolutePath(relative), pdf);
      await tenantQuery(t.tenantId, `UPDATE Requests SET ArchiveStatus = 'Stored', PdfLocalPath = @P, PdfSha256 = @S WHERE TenantId = @TenantId AND RequestId = @R`,
        { P: relative, S: crypto.createHash('sha256').update(pdf).digest(), R: requestId });
      return { requestId, relative };
    };
    const good = await make();
    const tampered = await make();
    fs.appendFileSync(pdfAbsolutePath(tampered.relative), 'edited later');

    // before the copy, downloads still work from the old file
    expect((await request(app).get(`${api}/admin/requests/${good.requestId}/pdf`).set(bearer(tok.admin))).status).toBe(200);

    const result = await backfillPdfFiles();
    expect(result.skipped.some((s) => s.includes(tampered.relative) && s.includes('changed'))).toBe(true);
    expect((await storedPdf(good.requestId)).Content.toString()).toBe(`%PDF-1.4 old archive ${good.requestId}`);
    expect(await storedPdf(tampered.requestId)).toBeUndefined();
    expect((await backfillPdfFiles()).copied).toBe(0); // safe to run again

    const [audited] = await unscopedQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM AuditLog WHERE RequestId = @R AND Action = 'archive.pdf_copied_to_database'`, { R: good.requestId });
    expect(audited.n).toBe(1);
  });
});

describe('PDF download access', () => {
  it('own requests only for submitters; admins can fetch any in their tenant; 409 until it is made', async () => {
    const requestId = await closedRequest('approve');
    expect((await request(app).get(`${api}/my/requests/${requestId}/pdf`).set(bearer(tok.sam))).body.error.code).toBe('pdf_not_ready');
    expect((await request(app).get(`${api}/my/requests/${requestId}`).set(bearer(tok.sam))).body.request.pdfAvailable).toBe(false);
    await processArchive({ tenantId: t.tenantId });

    // the submitter's own request page offers it, and it downloads
    expect((await request(app).get(`${api}/my/requests/${requestId}`).set(bearer(tok.sam))).body.request.pdfAvailable).toBe(true);
    const own = await request(app).get(`${api}/my/requests/${requestId}/pdf`).set(bearer(tok.sam));
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('application/pdf');

    expect((await request(app).get(`${api}/my/requests/${requestId}/pdf`).set(bearer(tok.sue))).status).toBe(404);
    expect((await request(app).get(`${api}/admin/requests/${requestId}/pdf`).set(bearer(tok.sam))).status).toBe(403);
    const admin = await request(app).get(`${api}/admin/requests/${requestId}/pdf`).set(bearer(tok.admin));
    expect(admin.status).toBe(200);
    expect(admin.headers['content-disposition']).toMatch(/attachment; filename="Capex-Request-2026_REQ-\d{6}_\d{8}\.pdf"/);
    const detail = (await request(app).get(`${api}/admin/requests/${requestId}`).set(bearer(tok.admin))).body.archive;
    expect(detail).toMatchObject({ status: 'Stored', pdfAvailable: true });
    expect(detail.pdfBytes).toBeGreaterThan(1000);

    const other = await makeTenant();
    await makeUser(other.tenantId, 'root@other.test', ['Admin']);
    const otherAdmin = (await login(other.slug, 'root@other.test')).body.accessToken;
    expect((await request(app).get(`${api}/admin/requests/${requestId}/pdf`).set(bearer(otherAdmin))).status).toBe(404);
  });

  it('the approvers of a request can download it; other people cannot', async () => {
    const requestId = await closedRequest('approve');
    await processArchive({ tenantId: t.tenantId });
    const [first] = await tenantQuery<{ RequestStepId: number }>(t.tenantId, 'SELECT TOP 1 RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R ORDER BY StepOrder', { R: requestId });
    expect((await request(app).get(`${api}/approvals/${first.RequestStepId}`).set(bearer(tok.ann))).body.request.pdfAvailable).toBe(true);

    const byAnn = await request(app).get(`${api}/approvals/requests/${requestId}/pdf`).set(bearer(tok.ann));
    expect(byAnn.status).toBe(200);
    expect(byAnn.headers['content-type']).toBe('application/pdf');
    expect((await request(app).get(`${api}/approvals/requests/${requestId}/pdf`).set(bearer(tok.sue))).status).toBe(404); // not an approver of it
    const [logged] = await tenantQuery<{ n: number }>(t.tenantId, `SELECT COUNT(*) AS n FROM AuditLog WHERE TenantId = @TenantId AND RequestId = @R AND Action = 'pdf.downloaded' AND UserId = @U`, { R: requestId, U: ids.ann });
    expect(logged.n).toBe(1);
  });
});

describe('SharePoint is gone', () => {
  it('its settings and routes no longer exist', async () => {
    const patch = await request(app).patch(`${api}/admin/settings`).set(bearer(tok.admin)).send({ sharePointMode: 'graph' });
    expect(patch.status).toBe(200);
    expect(patch.body.changed).toEqual([]); // not a setting any more: ignored
    const settings = (await request(app).get(`${api}/admin/settings`).set(bearer(tok.admin))).body.settings;
    expect(JSON.stringify(settings)).not.toMatch(/sharePoint|graph|archiveDestination/i);
    expect((await request(app).get(`${api}/admin/forms/${formId}/sharepoint`).set(bearer(tok.admin))).status).toBe(404);
    expect((await request(app).get(`${api}/admin/sharepoint/resolve?siteUrl=https://x.sharepoint.com/sites/a`).set(bearer(tok.admin))).status).toBe(404);
  });
});
