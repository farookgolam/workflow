// Each customer is reached at its own address ("sub-site"). The host decides which customer a
// request belongs to - nothing in the body can talk the server into another one.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/db/pool';
import { app, bearer, loginAt, makeTenant, makeUser, unique } from './helpers';

let a: { tenantId: number; slug: string; host: string | null };
let b: { tenantId: number; slug: string; host: string | null };

beforeAll(async () => {
  const slugA = unique('host-a');
  const slugB = unique('host-b');
  a = await makeTenant(slugA, `${slugA}.example.test`);
  b = await makeTenant(slugB, `${slugB}.example.test`);
  // the same address is a different person in each organisation
  await makeUser(a.tenantId, 'shared@example.test', ['Admin'], 'A Admin');
  await makeUser(b.tenantId, 'shared@example.test', ['Admin'], 'B Admin');
  await makeUser(a.tenantId, 'only-in-a@example.test', ['Submitter']);
});
afterAll(closePool);

describe('the address decides the customer', () => {
  it('signs in without the body naming an organisation at all', async () => {
    const ra = await loginAt(a.host!, 'shared@example.test');
    const rb = await loginAt(b.host!, 'shared@example.test');

    expect(ra.status).toBe(200);
    expect(ra.body.user).toMatchObject({ tenantId: a.tenantId, displayName: 'A Admin' });
    expect(rb.body.user).toMatchObject({ tenantId: b.tenantId, displayName: 'B Admin' });
  });

  it('a person who exists only in one customer cannot sign in at another address', async () => {
    expect((await loginAt(a.host!, 'only-in-a@example.test')).status).toBe(200);
    expect((await loginAt(b.host!, 'only-in-a@example.test')).status).toBe(401);
  });

  it('naming a different organisation from this address is refused, not honoured', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Host', a.host!)
      .send({ email: 'shared@example.test', password: '482615', tenantSlug: b.slug });
    expect(res.status).toBe(401);

    // the matching slug is harmless: it is the same customer the host already named
    const ok = await request(app)
      .post('/api/v1/auth/login')
      .set('Host', a.host!)
      .send({ email: 'shared@example.test', password: '482615', tenantSlug: a.slug });
    expect(ok.status).toBe(200);
    expect(ok.body.user.tenantId).toBe(a.tenantId);
  });

  it('a token minted at one address is still only good for its own customer data', async () => {
    const tokenA = (await loginAt(a.host!, 'shared@example.test')).body.accessToken;

    // the token carries the customer; arriving at B's address does not move it
    const users = await request(app).get('/api/v1/admin/users').set(bearer(tokenA)).set('Host', b.host!);
    expect(users.status).toBe(200);
    expect(users.body.users.map((u: { email: string }) => u.email).sort()).toEqual(['only-in-a@example.test', 'shared@example.test']);
  });

  it('first-time setup and forgotten-key also follow the address', async () => {
    const started = await request(app).post('/api/v1/auth/start').set('Host', a.host!).send({ email: 'shared@example.test' });
    expect(started.status).toBe(200);
    expect(started.body.next).toBe('password'); // this person exists here and has a key

    const elsewhere = await request(app).post('/api/v1/auth/start').set('Host', b.host!).send({ email: 'only-in-a@example.test' });
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.body.next).toBe('setup'); // unknown at B's address: a new account would be created there
  });
});
