import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processArchive } from '../src/archive/worker';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { sigPathData } from '../src/forms/sigpad';
import { app, bearer, login, makeTenant, makeUser, recordStepAnswers } from './helpers';

const api = '/api/v1';
let t: { tenantId: number; slug: string };
let formId: number;
const ids: Record<string, number> = {};
const tok: Record<string, string> = {};
const submit = (values: Record<string, unknown>) => request(app).post(`${api}/forms/${formId}/requests`).set(bearer(tok.sam)).send({ values });

beforeAll(async () => {
  t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'], ann: ['Approver'] } as const)) {
    ids[name] = await makeUser(t.tenantId, `${name}@sig.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@sig.test`)).body.accessToken;
  }
  const created = await request(app).post(`${api}/admin/forms`).set(bearer(tok.admin)).send({ name: 'Signed', slug: 'signed', fields: [{ key: 'note', label: 'Note', type: 'text' }, { key: 'sign', label: 'Sign here', type: 'sigpad', required: true }] });
  expect(created.status).toBe(201);
  formId = created.body.formId;
  await request(app).put(`${api}/admin/forms/${formId}/chain`).set(bearer(tok.admin)).send({ steps: [{ name: 'Check', approverUserId: ids.ann }] });
});
afterAll(closePool);

describe('drawn signature control', () => {
  it('stores the pen strokes, kept on the pad and rounded, and shows them to the approver and in the PDF', async () => {
    const res = await submit({ sign: { strokes: [[10.04, 20.06, 30, 40, 50.5, 60], [], [-5, 250, 700, 100], [7, 7]], extra: 'ignored' } });
    expect(res.status).toBe(201);
    const [stored] = await tenantQuery<{ Value: string }>(t.tenantId, "SELECT Value FROM RequestData WHERE TenantId = @TenantId AND RequestId = @R AND FieldKey = 'sign'", { R: res.body.requestId });
    expect(JSON.parse(stored.Value)).toEqual({ w: 600, h: 200, strokes: [[10, 20.1, 30, 40, 50.5, 60], [0, 200, 600, 100], [7, 7]] });

    const [step] = await tenantQuery<{ RequestStepId: number }>(t.tenantId, 'SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R', { R: res.body.requestId });
    const page = (await request(app).get(`${api}/approvals/${step.RequestStepId}`).set(bearer(tok.ann))).body;
    expect(page.submission.find((f: { key: string }) => f.key === 'sign')).toMatchObject({ type: 'sigpad', value: stored.Value });

    expect((await request(app).post(`${api}/approvals/${step.RequestStepId}/decision`).set(bearer(tok.ann)).send({ decision: 'approve' })).body.requestStatus).toBe('Approved');
    // an approver signature from an older chain is still drawn in the PDF
    await recordStepAnswers(t.tenantId, step.RequestStepId, [{ key: 'approverSign', label: 'Approver signature', type: 'sigpad', value: JSON.stringify({ w: 600, h: 200, strokes: [[1, 1, 100, 50]] }) }]);
    expect((await processArchive({ tenantId: t.tenantId })).generated).toBe(1);
  });

  it('draws smooth lines, and a tap as a dot', () => {
    expect(sigPathData([[0, 0, 10, 10, 20, 0], [5, 5]])).toBe('M0 0Q10 10 15 5L20 0M5 5l0.1 0');
  });

  it('rejects anything that is not pen strokes', async () => {
    for (const bad of ['Sam Submitter', 'data:image/png;base64,AAAA', 5, [[1, 2]], { strokes: 'x' }, { strokes: [[1, 2, 3]] }, { strokes: [[1, '2']] }, { strokes: [[1, null]] }, { strokes: [['<svg onload=alert(1)>', 2]] },
      { strokes: Array.from({ length: 301 }, () => [1, 1]) }, { strokes: [Array.from({ length: 40002 }, () => 1)] }]) {
      const res = await submit({ sign: bad });
      expect(res.status, JSON.stringify(bad).slice(0, 60)).toBe(400);
      expect(res.body.error.details[0].path).toBe('sign');
    }
  });

  it('treats an empty pad as not signed', async () => {
    expect((await submit({ sign: { strokes: [] } })).body.error.details[0].message).toBe('Sign here is required');
    expect((await submit({ sign: { strokes: [[]] } })).status).toBe(400);
    expect((await submit({})).status).toBe(400);
  });
});
