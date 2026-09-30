import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from './api';

/** GET `path` whenever it changes; `reload()` re-fetches in place (data stays visible meanwhile). */
export function useLoad<T>(path: string | null): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path)
      .then((d) => live && (setData(d), setError('')))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : 'Could not load data.'));
    return () => void (live = false);
  }, [path, tick]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}

/** Runs a mutating call and tracks busy / error / success-message state for a button or form. */
export function useAction(): { busy: boolean; error: string; ok: string; run: (fn: () => Promise<string | void>) => Promise<boolean>; clear: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const run = useCallback(async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError('');
    setOk('');
    try {
      setOk((await fn()) || '');
      return true;
    } catch (e) {
      const details = e instanceof ApiError && e.details.length ? ` (${e.details.map((d) => `${d.path}: ${d.message}`).join('; ')})` : '';
      setError((e instanceof ApiError ? e.message : 'Something went wrong.') + details);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, ok, run, clear: useCallback(() => (setError(''), setOk('')), []) };
}

export interface UserRow { userId: number; email: string; displayName: string; isActive: boolean; hasKey: boolean; locked: boolean; createdAt: string; roles: string[]; emailDigest?: boolean }
export interface FormRow { formId: number; name: string; slug: string; description: string | null; isActive: boolean; chainVersion: number | null; steps: number; requests: number }
