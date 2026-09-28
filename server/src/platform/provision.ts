// Creating a customer: the organisation, its request counter and its first administrator, in one
// transaction. Used by the global management API and by `npm run seed:tenant`, so a customer created
// from the console and one created from the command line are the same thing.
import crypto from 'node:crypto';
import { z } from 'zod';
import { audit, systemActor, type Actor } from '../audit/audit';
import { hashPassword, passwordKeyProblem } from '../auth/password';
import { unscopedQuery, withTx } from '../db/query';
import { AppError } from '../http/errors';
import { forgetTenant } from '../tenant';
import { createUser, normalizeEmail } from '../users/service';

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Lowercase letters, digits and hyphens only');

export const hostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/, 'That does not look like a host name');

export interface NewTenant {
  name: string;
  slug: string;
  host?: string | null;
  notifyEmail?: string | null;
  admin: { email: string; displayName: string };
  /** The administrator's 6-digit key. Omit to have one generated and returned once. */
  adminKey?: string;
  /** Checked folder for this customer's files, or null/absent for the database. */
  fileStorageRoot?: string | null;
}

export interface ProvisionedTenant {
  tenantId: number;
  adminUserId: number;
  /** Present only when the key was generated here: show it once, it is not stored in the clear. */
  generatedAdminKey: string | null;
}

/** A 6-digit key that passes the same "not obvious" rules a person's own key must pass. */
export function randomPasswordKey(): string {
  for (;;) {
    const key = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!passwordKeyProblem(key)) return key;
  }
}

/**
 * Creates the customer and its first administrator. `actor` names who did it in the customer's own
 * audit log - a global administrator appears as the system actor with their address in the detail,
 * because a platform administrator id is not a user id in this organisation.
 */
export async function provisionTenant(input: NewTenant, by?: { platformAdminEmail: string }): Promise<ProvisionedTenant> {
  const slug = slugSchema.parse(input.slug);
  const host = input.host ? hostSchema.parse(input.host) : null;
  const name = input.name.trim();
  const adminEmail = normalizeEmail(input.admin.email);

  const key = input.adminKey ?? randomPasswordKey();
  const problem = passwordKeyProblem(key);
  if (problem) throw new AppError(400, 'validation_failed', 'Invalid input', [{ path: 'adminKey', message: problem }]);
  const passwordHash = await hashPassword(key);

  const taken = await unscopedQuery<{ Slug: string; Host: string | null }>(
    'SELECT Slug, Host FROM Tenants WHERE Slug = @Slug OR (@Host IS NOT NULL AND Host = @Host)',
    { Slug: slug, Host: host },
  );
  if (taken.some((t) => t.Slug === slug)) throw new AppError(409, 'slug_taken', `Another organisation already uses the address "${slug}"`);
  if (taken.length) throw new AppError(409, 'host_taken', `Another organisation already uses the host "${host}"`);

  const actor: Actor = systemActor;
  const result = await withTx(async (tx) => {
    const [tenant] = await unscopedQuery<{ TenantId: number }>(
      'INSERT INTO Tenants (Name, Slug, Host, AdminNotifyEmail, FileStorageRoot) OUTPUT inserted.TenantId VALUES (@Name, @Slug, @Host, @Notify, @Root)',
      { Name: name, Slug: slug, Host: host, Notify: input.notifyEmail ?? adminEmail, Root: input.fileStorageRoot ?? null },
      tx,
    );
    await unscopedQuery('INSERT INTO RequestCounters (TenantId) VALUES (@TenantId)', { TenantId: tenant.TenantId }, tx);
    await unscopedQuery('INSERT INTO TenantSettings (TenantId) VALUES (@TenantId)', { TenantId: tenant.TenantId }, tx);
    const adminUserId = await createUser(
      tenant.TenantId,
      { email: adminEmail, displayName: input.admin.displayName.trim(), roles: ['Admin'], passwordHash },
      tx,
    );
    await audit(
      tenant.TenantId,
      actor,
      {
        action: 'tenant.created',
        entityType: 'Tenant',
        entityId: tenant.TenantId,
        detail: { slug, host, admin: adminEmail, ...(by ? { createdBy: by.platformAdminEmail } : {}) },
      },
      tx,
    );
    return { tenantId: tenant.TenantId, adminUserId };
  });

  forgetTenant();
  return { ...result, generatedAdminKey: input.adminKey ? null : key };
}
