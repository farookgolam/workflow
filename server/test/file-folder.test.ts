import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processArchive } from '../src/archive/worker';
import { dayFolder } from '../src/customer-files/files';
import { closePool } from '../src/db/pool';
import { tenantQuery, unscopedQuery } from '../src/db/query';
import { purgeDueTenants } from '../src/platform/purge';
import { PASSWORD, app, bearer, login, makePlatformAdmin, makeUser, platformLogin, unique } from './helpers';

const api = '/api/v1';
const PDF = Buffer.from('%PDF-1.4\n% attached\n');
let base: string; // a scratch area for the customer folders
let globalToken: string;
const asGlobal = (method: 'get' | 'post' | 'patch' | 'delete', p: string) => request(app)[method](`${api}/global${p}`).set(bearer(globalToken));

const binary = (r: request.Test) => r.buffer(true).parse((res, cb) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
});

/** A customer with a folder, a one-step form that allows attachments, and a submitter and approver. */
async function customerWithFolder(folder: string) {
  const slug = unique('files');
  const created = await asGlobal('post', '/tenants').send({ name: 'Files Co', slug, adminEmail: 'owner@files.test', adminDisplayName: 'Files Owner', adminKey: PASSWORD, fileStorageRoot: folder });
  expect(created.status).toBe(201);
  const tenantId: number = created.body.tenant.tenantId;
  const admin = (await login(slug, 'owner@files.test')).body.accessToken;
  const annId = await makeUser(tenantId, 'ann@files.test', ['Approver'], 'ANN');
  await makeUser(tenantId, 'sam@files.test', ['Submitter'], 'SAM');
  const ann = (await login(slug, 'ann@files.test')).body.accessToken;
  const sam = (await login(slug, 'sam@files.test')).body.accessToken;
  const formId = (await request(app).post(`${api}/admin/forms`).set(bearer(admin)).send({ name: 'Order', slug: 'order', fields: [{ key: 'title', label: 'Title', type: 'text', required: true }] })).body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(admin)).send({ steps: [{ name: 'Check', approverUserId: annId }] });
  return { slug, tenantId, created: created.body.tenant, admin, ann, sam, formId };
}

beforeAll(async () => {
  base = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'af-files-'));
  const g = await makePlatformAdmin();
  globalToken = (await platformLogin(g.email)).body.accessToken;
});
afterAll(async () => {
  await fs.promises.rm(base, { recursive: true, force: true });
  await closePool();
});

describe("a customer's own file folder", () => {
  it('refuses a folder that is not a full path, or a whole drive', async () => {
    for (const bad of ['relative\\folder', 'D:\\', '\\\\server', 'C:\\x\\..\\y']) {
      const res = await asGlobal('post', '/tenants').send({ name: 'Bad', slug: unique('bad'), adminEmail: 'a@bad.test', adminDisplayName: 'A Admin', fileStorageRoot: bad });
      expect(res.status, bad).toBe(400);
    }
  });

  it('keeps the PDF and attachments in the folder only, serves them, and refuses a changed file', async () => {
    const folder = path.join(base, 'acme');
    const c = await customerWithFolder(folder);
    expect(c.created.fileStorageRoot).toBe(folder);

    const sub = await request(app).post(`${api}/forms/${c.formId}/requests`).set(bearer(c.sam)).send({ values: { title: 'Desk' } });
    const requestId: number = sub.body.requestId;
    const requestNumber: string = sub.body.requestNumber;
    const [step] = await tenantQuery<{ RequestStepId: number }>(c.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R', { R: requestId });

    // every file of a request goes in the folder of the day it was submitted: <folder>\2026-09-28\
    const [{ SubmittedAt }] = await tenantQuery<{ SubmittedAt: Date }>(c.tenantId, 'SELECT SubmittedAt FROM Requests WHERE TenantId = @TenantId AND RequestId = @R', { R: requestId });
    const day = path.join(folder, dayFolder(SubmittedAt));
    expect(path.basename(day)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const up = await request(app).post(`${api}/approvals/${step.RequestStepId}/attachments?name=quote.pdf`).set(bearer(c.ann)).set('Content-Type', 'application/octet-stream').send(PDF);
    expect(up.status).toBe(201);
    const attachmentFile = path.join(day, `${requestNumber}_Step-1_quote.pdf`);
    expect(fs.readFileSync(attachmentFile).equals(PDF)).toBe(true);
    const [att] = await tenantQuery<{ HasContent: number; FilePath: string }>(c.tenantId, 'SELECT CASE WHEN Content IS NULL THEN 0 ELSE 1 END AS HasContent, FilePath FROM StepAttachments WHERE TenantId = @TenantId AND AttachmentId = @Id', { Id: up.body.attachment.attachmentId });
    expect(att).toEqual({ HasContent: 0, FilePath: attachmentFile });

    // a second file of the same name does not overwrite the first; removing it deletes its file
    const again = await request(app).post(`${api}/approvals/${step.RequestStepId}/attachments?name=quote.pdf`).set(bearer(c.ann)).set('Content-Type', 'application/octet-stream').send(PDF);
    const second = path.join(day, `${requestNumber}_Step-1_quote (2).pdf`);
    expect(fs.existsSync(second)).toBe(true);
    expect((await request(app).delete(`${api}/approvals/${step.RequestStepId}/attachments/${again.body.attachment.attachmentId}`).set(bearer(c.ann))).status).toBe(204);
    expect(fs.existsSync(second)).toBe(false);

    // approve, then the archive worker writes the PDF into the same day's folder, not the database
    expect((await request(app).post(`${api}/approvals/${step.RequestStepId}/decision`).set(bearer(c.ann)).send({ decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] } })).status).toBe(200);
    await processArchive({ tenantId: c.tenantId });
    const [doc] = await tenantQuery<{ HasContent: number; FilePath: string }>(c.tenantId, 'SELECT CASE WHEN Content IS NULL THEN 0 ELSE 1 END AS HasContent, FilePath FROM RequestDocuments WHERE TenantId = @TenantId AND RequestId = @R', { R: requestId });
    expect(doc.HasContent).toBe(0);
    expect(path.dirname(doc.FilePath)).toBe(day);
    expect(path.basename(doc.FilePath)).toContain(requestNumber);
    expect(fs.readFileSync(doc.FilePath).subarray(0, 4).toString()).toBe('%PDF');

    const pdf = await binary(request(app).get(`${api}/my/requests/${requestId}/pdf`).set(bearer(c.sam)));
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).equals(fs.readFileSync(doc.FilePath))).toBe(true);
    const detail = await request(app).get(`${api}/admin/requests/${requestId}`).set(bearer(c.admin));
    expect(detail.body.archive.pdfInFolder).toBe(true);
    expect(JSON.stringify(detail.body.archive)).not.toContain(folder); // the customer is not shown the server path

    // someone edits the file outside the app: it is refused, not served
    fs.appendFileSync(doc.FilePath, 'tampered');
    const refused = await request(app).get(`${api}/my/requests/${requestId}/pdf`).set(bearer(c.sam));
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('file_changed');
    fs.rmSync(attachmentFile);
    expect((await request(app).get(`${api}/admin/requests/${requestId}/attachments/${up.body.attachment.attachmentId}`).set(bearer(c.admin))).body.error.code).toBe('file_missing');
  });

  it('can be set, changed and cleared later; only new files follow', async () => {
    const slug = unique('later');
    const created = await asGlobal('post', '/tenants').send({ name: 'Later', slug, adminEmail: 'o@later.test', adminDisplayName: 'Later Owner' });
    const id = created.body.tenant.tenantId;
    expect(created.body.tenant.fileStorageRoot).toBeNull();

    const folder = path.join(base, 'later');
    expect((await asGlobal('patch', `/tenants/${id}`).send({ fileStorageRoot: folder })).body.tenant.fileStorageRoot).toBe(folder);
    expect(fs.existsSync(folder)).toBe(true); // created by the check
    expect((await asGlobal('patch', `/tenants/${id}`).send({ fileStorageRoot: null })).body.tenant.fileStorageRoot).toBeNull();

    const log = await unscopedQuery<{ DetailJson: string }>(`SELECT DetailJson FROM PlatformAuditLog WHERE TenantId = @Id AND Action = 'tenant.updated' ORDER BY PlatformAuditId`, { Id: id });
    expect(JSON.parse(log[0].DetailJson)).toMatchObject({ fileStorageRoot: folder, fileStorageRootWas: null });
  });

  it("deleting a removed customer deletes the files it wrote, not the folder's other contents", async () => {
    const folder = path.join(base, 'gone');
    const c = await customerWithFolder(folder);
    fs.writeFileSync(path.join(folder, 'not-ours.txt'), 'keep me');
    const sub = await request(app).post(`${api}/forms/${c.formId}/requests`).set(bearer(c.sam)).send({ values: { title: 'Chair' } });
    const [step] = await tenantQuery<{ RequestStepId: number }>(c.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R', { R: sub.body.requestId });
    await request(app).post(`${api}/approvals/${step.RequestStepId}/attachments?name=a.pdf`).set(bearer(c.ann)).set('Content-Type', 'application/octet-stream').send(PDF);
    const [{ SubmittedAt }] = await tenantQuery<{ SubmittedAt: Date }>(c.tenantId, 'SELECT SubmittedAt FROM Requests WHERE TenantId = @TenantId AND RequestId = @R', { R: sub.body.requestId });
    const written = path.join(folder, dayFolder(SubmittedAt), `${sub.body.requestNumber}_Step-1_a.pdf`);
    expect(fs.existsSync(written)).toBe(true);

    await asGlobal('patch', `/tenants/${c.tenantId}`).send({ isActive: false });
    expect((await asGlobal('delete', `/tenants/${c.tenantId}`).send({ confirmSlug: c.slug })).status).toBe(200);
    await unscopedQuery('UPDATE Tenants SET PurgeAfter = DATEADD(MINUTE, -1, SYSUTCDATETIME()) WHERE TenantId = @Id', { Id: c.tenantId });
    expect(await purgeDueTenants()).toContain(c.tenantId);

    expect(fs.existsSync(written)).toBe(false);
    expect(fs.existsSync(path.dirname(written))).toBe(false); // its emptied day folder too
    expect(fs.readFileSync(path.join(folder, 'not-ours.txt'), 'utf8')).toBe('keep me');
  });
});
