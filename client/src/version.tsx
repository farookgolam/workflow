// Notices when a new version of the app has been deployed while a page is open.
//
// The portal is a single-page app: a tab opened before an update keeps running the old code until it is reloaded,
// so (for example) an approver could be shown a screen without a control the new server requires. Every build
// writes /version.json with its own id (vite.config.ts) and compiles the same id in as __BUILD_ID__. This asks the
// server for the current id when the tab comes back into view, and every few minutes. When it differs:
//   - a message offers Reload straight away, and
//   - the next move to another page reloads that page from the server - nothing typed is lost that way, because
//     moving to another page leaves what was being typed anyway.
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

declare const __BUILD_ID__: string;

const CHECK_EVERY_MS = 5 * 60 * 1000;

async function serverBuild(): Promise<string | null> {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const { build } = (await res.json()) as { build?: unknown };
    return typeof build === 'string' ? build : null;
  } catch {
    return null; // offline, or the server is restarting: try again later
  }
}

export function UpdateWatcher() {
  const [stale, setStale] = useState(false);
  const { pathname } = useLocation();
  const shownAt = useRef(pathname);

  useEffect(() => {
    if (import.meta.env.DEV) return; // the dev server has no version.json and reloads by itself
    let live = true;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      void serverBuild().then((b) => { if (live && b && b !== __BUILD_ID__) setStale(true); });
    };
    check();
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, []);

  // outdated and the person has moved to another page: load that page from the server instead
  useEffect(() => {
    if (stale && pathname !== shownAt.current) window.location.reload();
    shownAt.current = pathname;
  }, [stale, pathname]);

  if (!stale) return null;
  return (
    <div className="update-banner" role="status">
      <span>A new version of ApprovalFlow is available.</span>
      <button type="button" className="primary" onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}
