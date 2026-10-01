// The global management console talks to /api/v1/global/* with its own session: a separate access
// token (audience "platform") held in memory and a separate httpOnly refresh cookie scoped to
// /api/v1/global/auth. Nothing here can be used against a customer's API, or the other way round.
import { ApiError } from '../api';

export interface PlatformAdmin {
  platformAdminId: number;
  email: string;
  displayName: string;
}

let accessToken: string | null = null;
let onSessionLost: () => void = () => {};
export const setSessionLostHandler = (fn: () => void) => (onSessionLost = fn);

let refreshing: Promise<PlatformAdmin | null> | null = null;
export function refreshSession(): Promise<PlatformAdmin | null> {
  refreshing ??= fetch('/api/v1/global/auth/refresh', { method: 'POST', credentials: 'include' })
    .then(async (res) => {
      if (!res.ok) return null;
      const body = await res.json();
      accessToken = body.accessToken;
      return body.admin as PlatformAdmin;
    })
    .catch(() => null)
    .finally(() => (refreshing = null));
  return refreshing;
}

async function raw(path: string, init: { method?: string; body?: unknown }): Promise<Response> {
  return fetch(`/api/v1/global${path}`, {
    method: init.method ?? 'GET',
    credentials: 'include',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** Saves a file the server sends (e.g. a customer's PDF export), under the name it gives in Content-Disposition. */
export async function gdownload(path: string, fallbackName: string): Promise<void> {
  let res = await raw(path, {});
  if (res.status === 401 && (await refreshSession())) res = await raw(path, {});
  if (!res.ok) {
    const e = (await res.json().catch(() => null))?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? 'Download failed', e?.details ?? []);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function gapi<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res = await raw(path, init);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) res = await raw(path, init);
    else onSessionLost();
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const e = body?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details ?? []);
  }
  return body as T;
}

export async function signIn(email: string, passwordKey: string): Promise<PlatformAdmin> {
  const body = await gapi<{ accessToken: string; admin: PlatformAdmin }>('/auth/login', { method: 'POST', body: { email, password: passwordKey } });
  accessToken = body.accessToken;
  return body.admin;
}

/** Change your own key. Every other session is signed out, so this one gets a fresh token. */
export async function changeKey(currentPassword: string, newPassword: string): Promise<void> {
  const body = await gapi<{ accessToken: string }>('/auth/change-key', { method: 'POST', body: { currentPassword, newPassword } });
  accessToken = body.accessToken;
}

export async function signOut(): Promise<void> {
  await gapi('/auth/logout', { method: 'POST' }).catch(() => {});
  accessToken = null;
}

export interface TenantSummary {
  tenantId: number;
  name: string;
  slug: string;
  host: string | null;
  url: string;
  notifyEmail: string | null;
  isActive: boolean;
  createdAt: string;
  counts: { users: number; admins: number; forms: number; requests: number; openRequests: number };
  lastActivityAt: string | null;
  /** Set once removed: kept (restorable) until purgeAfter, then deleted for good. */
  removedAt: string | null;
  purgeAfter: string | null;
  /** Folder for this customer's files; null when they are kept in the database. */
  fileStorageRoot: string | null;
}

export interface GlobalAdminSummary {
  platformAdminId: number;
  email: string;
  displayName: string;
  isActive: boolean;
  locked: boolean;
  createdAt: string;
  lastSignInAt: string | null;
}

export interface TenantAdmin {
  userId: number;
  email: string;
  displayName: string;
  isActive: boolean;
  hasKey: boolean;
}
