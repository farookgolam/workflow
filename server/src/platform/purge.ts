// Final deletion of removed customers.
//
// "Remove" in the global console only marks a suspended customer (Tenants.RemovedAt / PurgeAfter); its data
// stays, restorable, for TENANT_REMOVAL_DAYS. This job deletes the ones whose time is up: every row through
// dbo.PurgeTenant (migration 016), then its files. The global audit log keeps "tenant.deleted" for good.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { unscopedQuery } from '../db/query';
import { forgetTenant } from '../tenant';
import { platformAudit } from './identity';

/** Where a customer's files live on disk: PDFs from before they were kept in the database, and dry-run mail. */
const tenantFolders = (tenantId: number) => [
  path.join(config.storageDir, 'pdf', String(tenantId)),
  path.join(config.storageDir, 'mail', `tenant-${tenantId}`),
];

interface Due {
  TenantId: number;
  Name: string;
  Slug: string;
  Host: string | null;
  RemovedAt: Date;
}

/** Purges every removed customer whose grace period has ended. Returns the ids it deleted. */
export async function purgeDueTenants(): Promise<number[]> {
  const due = await unscopedQuery<Due>(
    `SELECT TenantId, Name, Slug, Host, RemovedAt FROM Tenants
      WHERE RemovedAt IS NOT NULL AND PurgeAfter <= SYSUTCDATETIME() AND IsActive = 0
      ORDER BY PurgeAfter`,
  );
  const done: number[] = [];
  for (const t of due) {
    try {
      await unscopedQuery('EXEC dbo.PurgeTenant @TenantId = @Id', { Id: t.TenantId });
    } catch (err) {
      console.error(`[tenant purge] ${t.Slug} (${t.TenantId}):`, (err as Error).message);
      continue; // retried on the next run
    }
    forgetTenant();

    const leftovers: string[] = [];
    for (const dir of tenantFolders(t.TenantId)) {
      try {
        await fs.promises.rm(dir, { recursive: true, force: true });
      } catch {
        leftovers.push(dir);
      }
    }

    await platformAudit(null, null, {
      action: 'tenant.deleted',
      entityType: 'Tenant',
      entityId: t.TenantId,
      tenantId: t.TenantId,
      detail: {
        name: t.Name,
        slug: t.Slug,
        host: t.Host,
        removedAt: t.RemovedAt,
        ...(leftovers.length ? { foldersNotRemoved: leftovers } : {}),
      },
    });
    done.push(t.TenantId);
  }
  return done;
}

export function startTenantPurge(intervalMs = 60 * 60_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const ids = await purgeDueTenants();
      if (ids.length) console.log(`[tenant purge] deleted ${ids.length} removed customer(s): ${ids.join(', ')}`);
    } catch (err) {
      console.error('[tenant purge]', (err as Error).message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  console.log(`Tenant purge job started (removed customers are kept ${config.tenantRemovalDays} days)`);
  return () => clearInterval(timer);
}
