export interface User {
  userId: number;
  tenantId: number;
  email: string;
  displayName: string;
  roles: ('Admin' | 'Approver' | 'Submitter')[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
  /** Field-level messages keyed by field path, for forms. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries(this.details.map((d) => [d.path, d.message]));
  }
}

// The access token lives only in memory; the refresh token is an httpOnly cookie the
// script can never read. A page reload restores the session through /auth/refresh.
let accessToken: string | null = null;
let onSessionLost: () => void = () => {};
export const setSessionLostHandler = (fn: () => void) => (onSessionLost = fn);

let refreshing: Promise<User | null> | null = null;
export function refreshSession(): Promise<User | null> {
  const attempt = () => fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
  refreshing ??= attempt()
    .then(async (first) => {
      let res = first;
      // another tab rotated the cookie at the same instant - the jar now holds the new one
      if (res.status === 401 && (await res.clone().json().catch(() => null))?.error?.code === 'refresh_race') {
        await new Promise((r) => setTimeout(r, 400));
        res = await attempt();
      }
      if (!res.ok) return null;
      const body = await res.json();
      accessToken = body.accessToken;
      return body.user as User;
    })
    .catch(() => null)
    .finally(() => (refreshing = null));
  return refreshing;
}

async function raw(path: string, init: { method?: string; body?: unknown }): Promise<Response> {
  return fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    credentials: 'include',
    headers: {
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res = await raw(path, init);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    // access token expired: rotate once and replay
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

/**
 * A global administrator can open this portal as one of its administrators. The token arrives in the
 * URL fragment (never sent to a server), is kept in memory like any other access token, and gets no
 * refresh cookie - when it expires, the support session simply ends.
 */
export function takeSupportToken(): boolean {
  const match = /(?:^|[#&])support=([^&]+)/.exec(window.location.hash);
  if (!match) return false;
  accessToken = decodeURIComponent(match[1]);
  history.replaceState(null, '', window.location.pathname + window.location.search);
  return true;
}

export const me = () => api<{ user: User }>('/auth/me').then((r) => r.user);

export interface Site {
  slug: string;
  name: string;
  brandColor: string | null;
  logoDataUrl: string | null;
}
/** Which customer this address belongs to, and how it is branded. Public: needed before sign-in. */
export const site = () => api<{ site: Site }>('/site').then((r) => r.site);

export async function login(email: string, passwordKey: string): Promise<User> {
  const body = await api<{ accessToken: string; user: User }>('/auth/login', { method: 'POST', body: { email, password: passwordKey } });
  accessToken = body.accessToken;
  return body.user;
}

export type StartResult = { next: 'password' } | { next: 'setup'; verification: boolean; needsName: boolean; displayName: string | null };
/** Step 1 of sign-in: tells the UI whether this address signs in with its key or still has to create one. */
export const startSignIn = (email: string) => api<StartResult>('/auth/start', { method: 'POST', body: { email } });

/** Forgotten key, self-service: emails a one-time code (always answers the same, whether or not the address is known). */
export const forgotKey = (email: string) => api('/auth/forgot', { method: 'POST', body: { email } });
export async function resetKey(input: { email: string; code: string; passwordKey: string }): Promise<User> {
  const body = await api<{ accessToken: string; user: User }>('/auth/reset-key', { method: 'POST', body: input });
  accessToken = body.accessToken;
  return body.user;
}

export interface SetupInput { email: string; passwordKey: string; code?: string; displayName?: string }
export async function setup(input: SetupInput): Promise<User> {
  const body = await api<{ accessToken: string; user: User }>('/auth/setup', { method: 'POST', body: input });
  accessToken = body.accessToken;
  return body.user;
}

export async function logout(): Promise<void> {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  accessToken = null;
}

/** Authenticated file download: fetches with the bearer token, then hands the blob to the browser. */
/** Downloads a file the server makes; `body` sends a POST (a report export carries its whole definition). */
export async function download(path: string, fallbackName: string, body?: unknown): Promise<void> {
  const init = body === undefined ? {} : { method: 'POST', body };
  let res = await raw(path, init);
  if (res.status === 401 && (await refreshSession())) res = await raw(path, init);
  if (!res.ok) {
    const e = (await res.json().catch(() => null))?.error;
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? 'Download failed');
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Sends a file as the raw request body (used for Excel lookup imports). */
export async function uploadFile<T>(path: string, file: File, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  const send = () => fetch(`/api/v1${path}`, { method, credentials: 'include', headers: { 'Content-Type': 'application/octet-stream', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }, body: file });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? 'error', body?.error?.message ?? `Upload failed (${res.status})`, body?.error?.details ?? []);
  return body as T;
}
