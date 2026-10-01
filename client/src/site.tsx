// Which customer this address is. Fetched once, before anybody signs in, so the sign-in page and the
// portal header can carry the customer's own name, logo and accent colour.
import { useEffect, useState } from 'react';
import { site as fetchSite, type Site } from './api';

/** The product's own name: the browser tab, and the header and sign-in page of a customer with no name of its own. */
export const PRODUCT = 'FileBank WorkFlow';

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
    // the customer's name first, the product's after it, so the product name always shows in the tab
    document.title = value?.name && value.name !== PRODUCT ? `${value.name} · ${PRODUCT}` : PRODUCT;
  }, [value]);

  return value;
}
