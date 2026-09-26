import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { app, bearer, login, makePlatformAdmin, makeTenant, makeUser, platformLogin } from './helpers';

const api = '/api/v1';
const tok: Record<string, string> = {};

beforeAll(async () => {
  const t = await makeTenant();
  for (const [name, roles] of Object.entries({ admin: ['Admin'], sam: ['Submitter'] } as const)) {
    await makeUser(t.tenantId, `${name}@help.test`, [...roles], name.toUpperCase());
    tok[name] = (await login(t.slug, `${name}@help.test`)).body.accessToken;
  }
  const g = await makePlatformAdmin();
  tok.global = (await platformLogin(g.email)).body.accessToken;
});
afterAll(closePool);

const linkFor = (as: string, manual: string) => request(app).post(`${api}/help/link`).set(bearer(tok[as])).send({ manual });

describe('manuals are for signed-in people only', () => {
  it('cannot be read without a link from a signed-in session', async () => {
    expect((await request(app).get(`${api}/help/manuals/ApprovalFlow-User-Manual.pdf`)).status).toBe(401);
    expect((await request(app).get(`${api}/help/manuals/ApprovalFlow-User-Manual.pdf?t=forged`)).status).toBe(401);
    expect((await request(app).post(`${api}/help/link`).send({ manual: 'user' })).status).toBe(401);
    // a sign-in token is not a manual link
    expect((await request(app).get(`${api}/help/manuals/ApprovalFlow-User-Manual.pdf?t=${tok.sam}`)).status).toBe(401);
  });

  it('gives each person the manuals for their role, as a PDF the browser can show', async () => {
    const user = await linkFor('sam', 'user');
    expect(user.status).toBe(200);
    const pdf = await request(app).get(user.body.url).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-security-policy']).not.toMatch(/object-src/);
    expect(pdf.headers['cache-control']).toBe('no-store');

    expect((await linkFor('sam', 'admin')).status).toBe(403);
    expect((await request(app).get((await linkFor('admin', 'admin')).body.url)).status).toBe(200);
    expect((await request(app).post(`${api}/global/help/link`).set(bearer(tok.admin))).status).toBe(401); // not a global administrator
    expect((await request(app).get((await request(app).post(`${api}/global/help/link`).set(bearer(tok.global))).body.url)).status).toBe(200);
  });

  it('a link opens only the manual it was made for', async () => {
    const t = new URL(`http://x${(await linkFor('sam', 'user')).body.url}`).searchParams.get('t');
    expect((await request(app).get(`${api}/help/manuals/ApprovalFlow-Administrator-Manual.pdf?t=${encodeURIComponent(t!)}`)).status).toBe(401);
    expect((await request(app).get(`${api}/help/manuals/..%2F..%2Fserver%2F.env?t=${encodeURIComponent(t!)}`)).status).toBe(401);
  });
});
