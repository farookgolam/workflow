import type { Request } from 'express';
import { config } from './config';
import { unscopedQuery } from './db/query';
import { AppError } from './http/errors';

/**
 * Which customer a request belongs to.
 *
 * The host decides: a customer is reached at its own `Tenants.Host`, or - with APP_DOMAIN set -
 * at `<slug>.<APP_DOMAIN>`. A deployment with one customer and no host routing still works: the
 * resolver falls back to TENANT_SLUG, and then to the only active customer.
 *
 * `slug` stays an internal escape hatch for tests and tooling. When the host already named a
 * customer, a slug naming a different one is refused rather than honoured - the host wins, always.
 */
export interface Tenant {
  tenantId: number;
  slug: string;
  name: string;
  host: string | null;
}

interface Row {
  TenantId: number;
  Slug: string;
  Name: string;
  Host: string | null;
}

const toTenant = (r: Row): Tenant => ({ tenantId: r.TenantId, slug: r.Slug, name: r.Name, host: r.Host });

const SELECT = 'SELECT TenantId, Slug, Name, Host FROM Tenants WHERE IsActive = 1';
const INVALID_LOGIN = () => new AppError(401, 'invalid_credentials', 'Incorrect email or password key');
const UNKNOWN_SITE = () => new AppError(404, 'unknown_site', 'There is no organisation at this address');

// Customers are created rarely and the rows are tiny, so a process-lifetime cache is fine.
// Anything that creates, renames or suspends a customer calls forgetTenant().
const cache = new Map<string, Tenant>();
export function forgetTenant(slugOrHost?: string): void {
  if (!slugOrHost) cache.clear();
  else for (const [key, t] of cache) if (t.slug === slugOrHost || t.host === slugOrHost || key === slugOrHost) cache.delete(key);
}

async function lookup(key: string, where: string, param: string | number): Promise<Tenant | null> {
  const hit = cache.get(key);
  if (hit) return hit;
  const [row] = await unscopedQuery<Row>(`${SELECT} AND ${where}`, { Key: param });
  if (!row) return null;
  const tenant = toTenant(row);
  cache.set(key, tenant);
  return tenant;
}

export const tenantBySlug = (slug: string) => lookup(`slug:${slug}`, 'Slug = @Key', slug);
export const tenantById = (tenantId: number) => lookup(`id:${tenantId}`, 'TenantId = @Key', tenantId);
const tenantByOwnHost = (host: string) => lookup(`host:${host}`, 'Host = @Key', host);

/** The host as the browser sent it: express strips the port and honours X-Forwarded-Host when TRUST_PROXY is set. */
const hostOf = (req: Request): string => (req.hostname ?? '').trim().toLowerCase();

/** Is this host inside the space we route by host at all? If it is, an unknown host is a 404, never a fallback. */
function isRoutedHost(host: string): boolean {
  if (!host || !config.appDomain) return false;
  return host === config.appDomain || host.endsWith(`.${config.appDomain}`);
}

async function tenantByHost(host: string): Promise<Tenant | null> {
  if (!host || host === config.platformHost) return null;
  const own = await tenantByOwnHost(host);
  if (own) return own;
  if (!config.appDomain || !host.endsWith(`.${config.appDomain}`)) return null;
  const label = host.slice(0, -(config.appDomain.length + 1));
  // only a single label is a customer: a.b.approvals.example.com is not acme.approvals.example.com
  return label && !label.includes('.') ? tenantBySlug(label) : null;
}

/**
 * Resolves the customer for a request. Pass `null` for tooling that runs outside a request
 * (seed scripts, workers), where TENANT_SLUG or the only active customer applies.
 */
export async function resolveTenant(req: Request | null, slug?: string): Promise<Tenant> {
  const host = req ? hostOf(req) : '';

  const fromHost = host ? await tenantByHost(host) : null;
  if (fromHost) {
    if (slug && slug !== fromHost.slug) throw INVALID_LOGIN(); // naming another customer from this site is a bad sign-in
    return fromHost;
  }
  // inside the routed space, an address that matches no customer must not fall back to somebody else
  if (isRoutedHost(host) || (config.platformHost && host === config.platformHost)) throw UNKNOWN_SITE();

  if (slug) {
    const t = await tenantBySlug(slug);
    if (!t) throw INVALID_LOGIN(); // an unknown organisation looks like any other bad sign-in
    return t;
  }
  if (config.tenantSlug) {
    const t = await tenantBySlug(config.tenantSlug);
    if (!t) throw new AppError(503, 'not_configured', `TENANT_SLUG is "${config.tenantSlug}", but there is no active organisation with that slug.`);
    return t;
  }

  const rows = await unscopedQuery<Row>(`${SELECT.replace('SELECT', 'SELECT TOP 2')} ORDER BY TenantId`);
  if (rows.length === 1) return toTenant(rows[0]);
  throw new AppError(
    503,
    'not_configured',
    rows.length === 0
      ? 'The application has not been set up yet (run "npm run seed:tenant").'
      : 'Several organisations exist; reach each one on its own address (APP_DOMAIN / Tenants.Host) or set TENANT_SLUG.',
  );
}

export async function resolveTenantId(req: Request | null, slug?: string): Promise<number> {
  return (await resolveTenant(req, slug)).tenantId;
}

/** Where this customer's portal lives - the base for every link we put in an email. */
export function tenantBaseUrl(t: Pick<Tenant, 'slug' | 'host'>): string {
  const port = config.appPort ? `:${config.appPort}` : '';
  if (t.host) return `${config.appProtocol}://${t.host}${port}`;
  if (config.appDomain) return `${config.appProtocol}://${t.slug}.${config.appDomain}${port}`;
  return config.appBaseUrl;
}

/** Same, for the code paths that carry a slug rather than the whole customer (the workflow engine, the sweeper). */
export async function tenantBaseUrlBySlug(slug: string): Promise<string> {
  const t = await tenantBySlug(slug);
  return t ? tenantBaseUrl(t) : config.appBaseUrl;
}

/** Same, for the code paths that carry only the customer id (the reminder/escalation sweeper). */
export async function tenantBaseUrlById(tenantId: number): Promise<string> {
  const t = await tenantById(tenantId);
  return t ? tenantBaseUrl(t) : config.appBaseUrl;
}
