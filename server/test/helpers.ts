import request from 'supertest';
import { createApp } from '../src/app';
import { hashPassword } from '../src/auth/password';
import type { Role } from '../src/auth/middleware';
import { tenantQuery, unscopedQuery, withTx } from '../src/db/query';
import { createUser } from '../src/users/service';

export const app = createApp();
export const PASSWORD = '482615'; // a 6-digit password key

let seq = 0;
export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++seq}`;

let cachedHash: Promise<string> | null = null;

export async function makeTenant(slug = unique('t'), host: string | null = null): Promise<{ tenantId: number; slug: string; host: string | null }> {
  const [row] = await unscopedQuery<{ TenantId: number }>(
    'INSERT INTO Tenants (Name, Slug, Host) OUTPUT inserted.TenantId VALUES (@Name, @Slug, @Host)',
    { Name: slug, Slug: slug, Host: host },
  );
  return { tenantId: row.TenantId, slug, host };
}

/** A global administrator: not a row in Users, and carries no tenant. */
export async function makePlatformAdmin(email = `${unique('global')}@example.test`): Promise<{ platformAdminId: number; email: string }> {
  cachedHash ??= hashPassword(PASSWORD);
  const [row] = await unscopedQuery<{ PlatformAdminId: number }>(
    `INSERT INTO PlatformAdmins (Email, PasswordHash, DisplayName, PasswordSetAt)
     OUTPUT inserted.PlatformAdminId VALUES (@Email, @Hash, @Name, SYSUTCDATETIME())`,
    { Email: email, Hash: await cachedHash, Name: email },
  );
  return { platformAdminId: row.PlatformAdminId, email };
}

export async function makeUser(tenantId: number, email: string, roles: Role[], displayName = email): Promise<number> {
  cachedHash ??= hashPassword(PASSWORD);
  const passwordHash = await cachedHash;
  return withTx((tx) => createUser(tenantId, { email, displayName, roles, passwordHash }, tx));
}

export async function login(tenantSlug: string, email: string, password = PASSWORD) {
  return request(app).post('/api/v1/auth/login').send({ tenantSlug, email, password });
}

/** Sign in the way a browser does: the customer is decided by the address, not by the body. */
export async function loginAt(host: string, email: string, password = PASSWORD) {
  return request(app).post('/api/v1/auth/login').set('Host', host).send({ email, password });
}

export async function platformLogin(email: string, password = PASSWORD) {
  return request(app).post('/api/v1/global/auth/login').send({ email, password });
}

/**
 * Approvers no longer fill in controls; this writes the answers an approver gave under an older chain version
 * (a StepFields row on the step's definition, then the StepResponses row) so history reads can be tested.
 */
export async function recordStepAnswers(
  tenantId: number,
  requestStepId: number,
  answers: { key: string; label: string; type: string; value: string | null }[],
): Promise<void> {
  for (const [i, a] of answers.entries()) {
    await tenantQuery(
      tenantId,
      `DECLARE @StepId INT = (SELECT StepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestStepId = @RS);
       IF NOT EXISTS (SELECT 1 FROM StepFields WHERE TenantId = @TenantId AND StepId = @StepId AND FieldKey = @Key)
         INSERT INTO StepFields (TenantId, StepId, FieldKey, Label, FieldType, SortOrder) VALUES (@TenantId, @StepId, @Key, @Label, @Type, @Sort);
       INSERT INTO StepResponses (TenantId, RequestStepId, StepFieldId, FieldKey, FieldLabel, FieldType, SortOrder, Value)
       SELECT @TenantId, @RS, StepFieldId, FieldKey, Label, FieldType, SortOrder, @Value
         FROM StepFields WHERE TenantId = @TenantId AND StepId = @StepId AND FieldKey = @Key;`,
      { RS: requestStepId, Key: a.key, Label: a.label, Type: a.type, Sort: i + 1, Value: a.value },
    );
  }
}

export const bearer =(token: string) => ({ Authorization: `Bearer ${token}` });

export function refreshCookie(res: request.Response): string {
  const raw = ([] as string[]).concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('af_rt='));
  if (!raw) throw new Error('no refresh cookie set');
  return raw.split(';')[0];
}
