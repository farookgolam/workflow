import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import * as apiClient from './api';
import type { User } from './api';

interface AuthState {
  user: User | null;
  ready: boolean;
  /** True while this tab is a support session opened from the global management console. */
  support: boolean;
  signIn(email: string, passwordKey: string): Promise<User>;
  /** First-time setup (or after an administrator reset): creates the 6-digit key and signs in. */
  setUp(input: apiClient.SetupInput): Promise<User>;
  /** Forgotten key: emailed code + new key, then signed in. */
  resetKey(input: { email: string; code: string; passwordKey: string }): Promise<User>;
  signOut(): Promise<void>;
}
const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [support, setSupport] = useState(false);

  useEffect(() => {
    apiClient.setSessionLostHandler(() => setUser(null));
    if (apiClient.takeSupportToken()) {
      setSupport(true);
      apiClient
        .me()
        .then(setUser)
        .catch(() => setSupport(false))
        .finally(() => setReady(true));
      return;
    }
    apiClient.refreshSession().then((u) => {
      setUser(u);
      setReady(true);
    });
  }, []);

  const signIn = useCallback(async (email: string, passwordKey: string) => {
    const u = await apiClient.login(email, passwordKey);
    setUser(u);
    return u;
  }, []);
  const setUp = useCallback(async (input: apiClient.SetupInput) => {
    const u = await apiClient.setup(input);
    setUser(u);
    return u;
  }, []);
  const resetKey = useCallback(async (input: { email: string; code: string; passwordKey: string }) => {
    const u = await apiClient.resetKey(input);
    setUser(u);
    return u;
  }, []);
  const signOut = useCallback(async () => {
    await apiClient.logout();
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, ready, support, signIn, setUp, resetKey, signOut }), [user, ready, support, signIn, setUp, resetKey, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** Only same-app paths may be used as a post-sign-in destination (no open redirects). */
export const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/');

/** Gate for every signed-in page; remembers where the person was going (e.g. an emailed approval link). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  const location = useLocation();
  if (!ready) return <p className="muted center">Loading…</p>;
  if (!user) {
    const target = location.pathname + location.search;
    return <Navigate to={target === '/' ? '/login' : `/login?next=${encodeURIComponent(target)}`} replace />;
  }
  return <>{children}</>;
}
