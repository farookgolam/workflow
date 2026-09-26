// Which customer this address is. Fetched once, before anybody signs in, so the sign-in page and the
// portal header can carry the customer's own name, logo and accent colour.
import { useEffect, useState } from 'react';
import { site as fetchSite, type Site } from './api';

let cached: Site | null = null;

export function useSite(): Site | null {
  const [value, setValue] = useState<Site | null>(cached);
  useEffect(() => {
    if (cached) return;
    let live = true;
    fetchSite()
      .then((s) => {
        cached = s;
        if (live) setValue(s);
      })
      .catch(() => {}); // a deployment with no host routing simply has no branding
    return () => void (live = false);
  }, []);

  useEffect(() => {
    if (value?.brandColor) document.documentElement.style.setProperty('--accent', value.brandColor);
  }, [value]);

  return value;
}
