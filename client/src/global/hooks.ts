// The same load / action helpers the customer app uses, against the global API.
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../api';
import { gapi } from './api';

export function useGlobalLoad<T>(path: string | null): { data: T | null; error: string; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    gapi<T>(path)
      .then((d) => live && (setData(d), setError('')))
      .catch((e) => live && setError(e instanceof ApiError ? e.message : 'Could not load data.'));
    return () => void (live = false);
  }, [path, tick]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}

export function useGlobalAction(): { busy: boolean; error: string; ok: string; run: (fn: () => Promise<string | void>) => Promise<boolean>; clear: () => void } {
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
