import { isIP } from 'node:net';
import type { Request } from 'express';
import { tenantQuery, type Tx } from '../db/query';

/** Who did it and from where. userId null = system/scheduler. */
export interface Actor {
  userId: number | null;
  ip: string | null;
  userAgent: string | null;
  /** PlatformAdminId, when a global administrator is acting as this user. */
  impersonatedBy?: number;
}

export const systemActor: Actor = { userId: null, ip: null, userAgent: null };

/**
 * IIS/ARR appends the client's TCP port to X-Forwarded-For by default ("1.2.3.4:51234", "[::1]:51234").
 * Keep just the address, and unwrap IPv4-mapped IPv6 (::ffff:1.2.3.4). Returns null if what is left is not an IP.
 */
export const cleanIp = (ip: string | undefined): string | null => {
  if (!ip) return null;
  const bare = ip
    .trim()
    .replace(/^\[([^\]]+)\](?::\d+)?$/, '$1') // [v6]:port
    .replace(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/, '$1') // v4:port
    .replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, '$1');
  return isIP(bare) ? bare : null;
};

export function actorFrom(req: Request, userId: number | null = req.user?.userId ?? null): Actor {
  return {
    userId,
    ip: cleanIp(req.ip),
    userAgent: (req.get('user-agent') ?? '').slice(0, 400) || null,
    impersonatedBy: req.user?.impersonatedBy,
  };
}

export interface AuditEntry {
  action: string; // e.g. auth.login, request.submitted, step.approved
  entityType: string;
  entityId?: number | null;
  requestId?: number | null;
  fromState?: string | null;
  toState?: string | null;
  detail?: Record<string, unknown>;
}

/** Pass the transaction of the state change so the audit row commits or rolls back with it. */
export async function audit(tenantId: number, actor: Actor, e: AuditEntry, tx?: Tx): Promise<void> {
  await tenantQuery(
    tenantId,
    `INSERT INTO AuditLog (TenantId, UserId, IpAddress, UserAgent, Action, EntityType, EntityId, RequestId, FromState, ToState, DetailJson)
     VALUES (@TenantId, @UserId, @Ip, @Ua, @Action, @EntityType, @EntityId, @RequestId, @FromState, @ToState, @Detail)`,
    {
      UserId: actor.userId,
      Ip: actor.ip,
      Ua: actor.userAgent,
      Action: e.action,
      EntityType: e.entityType,
      EntityId: e.entityId ?? null,
      RequestId: e.requestId ?? null,
      FromState: e.fromState ?? null,
      ToState: e.toState ?? null,
      // support access is never silent: it is stamped on every row it produces
      Detail: e.detail || actor.impersonatedBy ? JSON.stringify({ ...e.detail, ...(actor.impersonatedBy ? { impersonatedByPlatformAdmin: actor.impersonatedBy } : {}) }) : null,
    },
    tx,
  );
}
