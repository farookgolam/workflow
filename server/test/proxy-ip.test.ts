import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanIp } from '../src/audit/audit';
import { createApp } from '../src/app';
import { closePool } from '../src/db/pool';
import { tenantQuery } from '../src/db/query';
import { makeTenant, makeUser, PASSWORD } from './helpers';

afterAll(closePool);

describe('client IP behind IIS/ARR', () => {
  it('strips the TCP port ARR appends to X-Forwarded-For', () => {
    expect(cleanIp('203.0.113.7:51234')).toBe('203.0.113.7');
    expect(cleanIp('[2001:db8::1]:51234')).toBe('2001:db8::1');
    expect(cleanIp('[::1]:53813')).toBe('::1');
    expect(cleanIp('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(cleanIp('2001:db8::1')).toBe('2001:db8::1');
    expect(cleanIp('not-an-ip')).toBeNull();
    expect(cleanIp(undefined)).toBeNull();
  });

  it('records the real client address in the audit log when one proxy is trusted', async () => {
    const app = createApp();
    app.set('trust proxy', 1); // what TRUST_PROXY=1 does in production
    const t = await makeTenant();
    const userId = await makeUser(t.tenantId, 'proxied@ip.test', ['Submitter']);
    const res = await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', '203.0.113.7:51234').send({ tenantSlug: t.slug, email: 'proxied@ip.test', password: PASSWORD });
    expect(res.status).toBe(200);
    const [row] = await tenantQuery<{ IpAddress: string }>(t.tenantId, `SELECT TOP 1 IpAddress FROM AuditLog WHERE TenantId = @TenantId AND UserId = @U AND Action = 'auth.login'`, { U: userId });
    expect(row.IpAddress).toBe('203.0.113.7');
  });
});
