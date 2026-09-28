import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};

const PDF = Buffer.from('%PDF-1.4\n% test document\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

const upload = (as: string, requestStepId: number, name: string, body: Buffer) =>
  request(app).post(`${api}/approvals/${requestStepId}/attachments?name=${encodeURIComponent(name)}`)
    .set(bearer(tok[as])).set('Content-Type', 'application/octet-stream').send(body);
const view = (as: string, requestStepId: number) => request(app).get(`${api}/approvals/${requestStepId}`).set(bearer(tok[as]));
const decide = (as: string, requestStepId: number) =>
  request(app).post(`${api}/approvals/${requestStepId}/decision`).set(bearer(tok[as])).send({ decision: 'approve' });
const approverGet = (as: string, requestId: number, attachmentId: number) =>
  request(app).get(`${api}/approvals/requests/${requestId}/attachments/${attachmentId}`).set(bearer(tok[as]));

async function newRequest(): Promise<{ requestId: number; steps: number[] }> {
  const res = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { title: 'Laptop' } });
  expect(res.status).toBe(201);
  const steps = await tenantQuery<{ RequestStepId: number }>(
    t.tenantId,
    'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R ORDER BY StepOrder',
    { R: res.body.requestId },
  );
  return { requestId: res.body.requestId, steps: steps.map((s) => s.RequestStepId) };
}

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ann: ['Approver'], bob: ['Approver'], cat: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@att.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@att.test`)).body.accessToken;
  }
  const form = await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({
    name: 'Purchase', slug: 'purchase', fields: [{ key: 'title', label: 'Title', type: 'text', required: true }],
  });
  formId = form.body.formId;
  const chain = await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({
    steps: [
      { name: 'Manager', approverUserId: ids.ann, allowAttachments: true },
      { name: 'Finance', approverUserId: ids.bob },
      { name: 'Director', approverUserId: ids.cat, allowAttachments: true },
    ],
  });
  expect(chain.status).toBe(200);
});
afterAll(closePool);

describe('step attachments', () => {
  it('the step setting is saved and read back in the form builder, off by default', async () => {
    const res = await request(app).get(`${api}/admin/forms/${formId}`).set(bearer(tok.admin));
    expect(res.body.steps.map((s: { allowAttachments: boolean }) => s.allowAttachments)).toEqual([true, false, true]);
  });

  it('an approver attaches documents on an allowed step; later approvers and admins see them, the submitter never', async () => {
    const { requestId, steps } = await newRequest();
    const added = await upload('ann', steps[0], 'quote.pdf', PDF);
    expect(added.status).toBe(201);
    expect(added.body.attachment).toMatchObject({ fileName: 'quote.pdf', contentType: 'application/pdf', sizeBytes: PDF.length });
    const attachmentId = added.body.attachment.attachmentId;

    const mine = await view('ann', steps[0]);
    expect(mine.body.step).toMatchObject({ allowAttachments: true, attachments: [expect.objectContaining({ fileName: 'quote.pdf', uploadedBy: 'ANN' })] });

    expect((await decide('ann', steps[0])).status).toBe(200);

    // the next approver sees it under the earlier step and can download it
    const bobs = await view('bob', steps[1]);
    expect(bobs.body.previousSteps[0].attachments.map((a: { fileName: string }) => a.fileName)).toEqual(['quote.pdf']);
    const file = await approverGet('bob', requestId, attachmentId).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(Buffer.compare(file.body as Buffer, PDF)).toBe(0);

    // an administrator too
    expect((await request(app).get(`${api}/admin/requests/${requestId}/attachments/${attachmentId}`).set(bearer(tok.admin))).status).toBe(200);
    const detail = await request(app).get(`${api}/admin/requests/${requestId}`).set(bearer(tok.admin));
    expect(detail.body.request.steps[0].attachments).toHaveLength(1);

    // the submitter: not in their view of the request, and no way to download it
    const own = await request(app).get(`${api}/my/requests/${requestId}`).set(bearer(tok.sam));
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toContain('quote.pdf');
    expect((await approverGet('sam', requestId, attachmentId)).status).toBe(404);

    const actions = await tenantQuery<{ Action: string }>(
      t.tenantId,
      `SELECT Action FROM AuditLog WHERE TenantId = @TenantId AND RequestId = @R AND Action LIKE 'attachment.%' ORDER BY AuditId`,
      { R: requestId },
    );
    expect(actions.map((a) => a.Action)).toEqual(['attachment.added', 'attachment.downloaded', 'attachment.downloaded']);
  });

  it('an approver never sees files attached at a later step', async () => {
    const { requestId, steps } = await newRequest();
    await decide('ann', steps[0]);
    await decide('bob', steps[1]);
    const later = await upload('cat', steps[2], 'final.png', PNG);
    expect(later.status).toBe(201);
    expect((await approverGet('ann', requestId, later.body.attachment.attachmentId)).status).toBe(404);
    expect((await approverGet('cat', requestId, later.body.attachment.attachmentId)).status).toBe(200);
  });

  it('refuses steps without the option, other people, and files that are not what they claim', async () => {
    const { steps } = await newRequest();
    expect((await upload('bob', steps[0], 'x.pdf', PDF)).status).toBe(404); // not their step
    await decide('ann', steps[0]);
    const off = await upload('bob', steps[1], 'x.pdf', PDF);
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('attachments_off');

    const { steps: s2 } = await newRequest();
    expect((await upload('ann', s2[0], 'tool.exe', Buffer.from('MZ....'))).body.error.code).toBe('file_type');
    expect((await upload('ann', s2[0], 'fake.pdf', Buffer.from('MZ not a pdf'))).body.error.code).toBe('file_content');
    expect((await upload('ann', s2[0], 'notes.txt', Buffer.from([0x61, 0x00, 0x62]))).body.error.code).toBe('file_content');
    expect((await upload('ann', s2[0], 'empty.pdf', Buffer.alloc(0))).status).toBe(400);
  });

  it('files can be removed while the step is open, never once it is decided', async () => {
    const { steps } = await newRequest();
    const a = (await upload('ann', steps[0], 'draft.pdf', PDF)).body.attachment;
    const b = (await upload('ann', steps[0], 'keep.pdf', PDF)).body.attachment;
    expect((await request(app).delete(`${api}/approvals/${steps[0]}/attachments/${a.attachmentId}`).set(bearer(tok.ann))).status).toBe(204);
    expect((await view('ann', steps[0])).body.step.attachments.map((x: { fileName: string }) => x.fileName)).toEqual(['keep.pdf']);

    await decide('ann', steps[0]);
    const late = await request(app).delete(`${api}/approvals/${steps[0]}/attachments/${b.attachmentId}`).set(bearer(tok.ann));
    expect(late.status).toBe(409);
    // and not even by going round the application
    await expect(
      tenantQuery(t.tenantId, 'DELETE FROM StepAttachments WHERE TenantId = @TenantId AND AttachmentId = @Id', { Id: b.attachmentId }),
    ).rejects.toThrow(/decided step/);
    await expect(
      tenantQuery(t.tenantId, `UPDATE StepAttachments SET FileName = N'x.pdf' WHERE TenantId = @TenantId AND AttachmentId = @Id`, { Id: b.attachmentId }),
    ).rejects.toThrow(/cannot be changed/);
  });

  it('allows at most 10 files on a step', async () => {
    const { steps } = await newRequest();
    for (let i = 0; i < 10; i++) expect((await upload('ann', steps[0], `f${i}.pdf`, PDF)).status).toBe(201);
    const eleventh = await upload('ann', steps[0], 'f10.pdf', PDF);
    expect(eleventh.status).toBe(409);
    expect(eleventh.body.error.code).toBe('too_many_files');
  });
});
