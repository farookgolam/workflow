import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { app, bearer, login, makeTenant, makeUser } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};
const admin = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string) => request(app)[method](`${api}/admin${url}`).set(bearer(tok.admin));

async function makeForm(slug: string) {
  const formId: number = (await admin('post', '/forms').send({ name: `Form ${slug}`, slug, fields: [{ key: 'title', label: 'Title', type: 'text', required: true }] })).body.formId;
  await admin('put', `/forms/${formId}/chain`).send({ steps: [{ name: 'Manager', approverUserId: ids.ann }] });
  return formId;
}
const count = async (table: string, where: string, params: Record<string, number>) =>
  (await tenantQuery<{ n: number }>(t.tenantId, `SELECT COUNT(*) AS n FROM ${table} WHERE TenantId = @TenantId AND ${where}`, params))[0].n;

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ann: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@fd.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@fd.test`)).body.accessToken;
  }
});
afterAll(closePool);

describe('deleting forms from the repository', () => {
  it('a form with no requests is removed completely, and its name can be used again', async () => {
    const formId = await makeForm('unused');
    expect((await request(app).delete(`${api}/admin/forms/${formId}`).set(bearer(tok.sam))).status).toBe(403);

    const res = await admin('delete', `/forms/${formId}`);
    expect(res.body).toEqual({ mode: 'deleted', name: 'Form unused', requests: 0, inProgress: 0 });

    expect(await count('Forms', 'FormId = @F', { F: formId })).toBe(0);
    expect(await count('FormFields', 'FormId = @F', { F: formId })).toBe(0);
    expect(await count('ApprovalChains', 'FormId = @F', { F: formId })).toBe(0);
    expect((await admin('get', `/forms/${formId}`)).status).toBe(404);
    expect((await admin('delete', `/forms/${formId}`)).status).toBe(404);
    expect((await admin('post', '/forms').send({ name: 'Again', slug: 'unused', fields: [{ key: 'a', label: 'A', type: 'text' }] })).status).toBe(201);
  });

  it('a form with requests disappears from the repository but its requests, history and in-flight approvals survive', async () => {
    const formId = await makeForm('used');
    const submitted = await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { title: 'Keep me' } });
    const requestId: number = submitted.body.requestId;

    const res = await admin('delete', `/forms/${formId}`);
    expect(res.body).toEqual({ mode: 'archived', name: 'Form used', requests: 1, inProgress: 1 });

    // gone for everyone who manages or starts forms
    expect((await admin('get', '/forms')).body.forms.map((f: { formId: number }) => f.formId)).not.toContain(formId);
    expect((await admin('get', `/forms/${formId}`)).status).toBe(404);
    expect((await admin('patch', `/forms/${formId}`).send({ isActive: true })).status).toBe(404); // cannot be resurrected through the API
    expect((await admin('put', `/forms/${formId}/chain`).send({ steps: [{ name: 'M', approverUserId: ids.ann }] })).status).toBe(404);
    expect((await request(app).get(`${api}/forms`).set(bearer(tok.sam))).body.forms.map((f: { formId: number }) => f.formId)).not.toContain(formId);
    expect((await request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values: { title: 'New' } })).status).toBe(404);

    // ...while the existing request is untouched and can still be decided
    const mine = (await request(app).get(`${api}/my/requests/${requestId}`).set(bearer(tok.sam))).body.request;
    expect(mine).toMatchObject({ formName: 'Form used', status: 'InProgress' });
    expect((await admin('get', `/requests/${requestId}`)).body.request.formName).toBe('Form used');
    const [step] = await tenantQuery<{ RequestStepId: number }>(t.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R', { R: requestId });
    const decided = await request(app).post(`${api}/approvals/${step.RequestStepId}/decision`).set(bearer(tok.ann)).send({ decision: 'approve', signature: { strokes: [[10, 10, 90, 40]] } });
    expect(decided.body.requestStatus).toBe('Approved');

    // the name is free again, and the deletion is audited
    expect((await admin('post', '/forms').send({ name: 'Form used', slug: 'used', fields: [{ key: 'a', label: 'A', type: 'text' }] })).status).toBe(201);
    const [log] = await tenantQuery<{ DetailJson: string; UserId: number }>(t.tenantId, `SELECT TOP 1 DetailJson, UserId FROM AuditLog WHERE TenantId = @TenantId AND Action = 'form.deleted' AND EntityId = @F`, { F: formId });
    expect(log.UserId).toBe(ids.admin);
    expect(JSON.parse(log.DetailJson)).toMatchObject({ mode: 'archived', requests: 1 });
  });

  it("cannot reach another organisation's form", async () => {
    const other = await makeTenant();
    await makeUser(other.tenantId, 'root@fd-other.test', ['Admin']);
    const otherTok = (await login(other.slug, 'root@fd-other.test')).body.accessToken;
    const formId = await makeForm('private');
    expect((await request(app).delete(`${api}/admin/forms/${formId}`).set(bearer(otherTok))).status).toBe(404);
    expect(await count('Forms', 'FormId = @F AND DeletedAt IS NULL', { F: formId })).toBe(1);
  });
});
