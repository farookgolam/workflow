import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as client from './api';
import type { PlatformAdmin } from './api';

interface GlobalAuthState {
  admin: PlatformAdmin | null;
  ready: boolean;
  signIn(email: string, passwordKey: string): Promise<PlatformAdmin>;
  signOut(): Promise<void>;
}

const Ctx = createContext<GlobalAuthState | null>(null);

export function GlobalAuthProvider({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<PlatformAdmin | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    client.setSessionLostHandler(() => setAdmin(null));
    client.refreshSession().then((a) => {
      setAdmin(a);
      setReady(true);
    });
  }, []);

  const signIn = useCallback(async (email: string, passwordKey: string) => {
    const a = await client.signIn(email, passwordKey);
    setAdmin(a);
    return a;
  }, []);
  const signOut = useCallback(async () => {
    await client.signOut();
    setAdmin(null);
  }, []);

  const value = useMemo(() => ({ admin, ready, signIn, signOut }), [admin, ready, signIn, signOut]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useGlobalAuth(): GlobalAuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useGlobalAuth outside GlobalAuthProvider');
  return ctx;
}
