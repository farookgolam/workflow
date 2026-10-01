import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** What GET /about returns: everyone signed in sees this much (server/src/about/routes.ts). */
export type AboutBasics = {
  product: string;
  version: string;
  updatedAt: string | null;
  contact: { website: string; websiteLabel: string; phone: string };
};

export const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/** Name, version, last update and contact, as rows of a table (the dialog below and the console's About page). */
export function AboutRows({ about }: { about: AboutBasics }) {
  return (
    <>
      <tr><th scope="row">Application</th><td>{about.product}</td></tr>
      <tr><th scope="row">Version</th><td>{about.version}</td></tr>
      <tr><th scope="row">Last updated</th><td>{when(about.updatedAt)}</td></tr>
      <tr><th scope="row">Contact us</th><td><a href={about.contact.website} target="_blank" rel="noreferrer">{about.contact.websiteLabel}</a></td></tr>
      <tr><th scope="row">Telephone</th><td><a href={`tel:${about.contact.phone.replace(/[^\d+]/g, '')}`}>{about.contact.phone}</a></td></tr>
    </>
  );
}

/** "About FileBank WorkFlow" in a modal window; Escape or Close shuts it. Drawn at page level, not inside the top bar it is opened from, so it takes none of the bar's colours. */
export function AboutDialog({ load, onClose }: { load: () => Promise<AboutBasics>; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [about, setAbout] = useState<AboutBasics | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    ref.current?.showModal();
    load().then(setAbout, (e: Error) => setError(e.message));
  }, [load]);
  return createPortal(
    <dialog ref={ref} className="about" aria-labelledby="about-title" onClose={onClose}>
      <img src="/filebank-logo.png" alt="FileBank" className="about-logo" />
      <h2 id="about-title">About {about?.product ?? 'FileBank WorkFlow'}</h2>
      {error && <p className="notice bad" role="alert">{error}</p>}
      {!about && !error && <p className="muted">Loading…</p>}
      {about && <table className="about-table"><tbody><AboutRows about={about} /></tbody></table>}
      <div className="actions"><button className="primary" autoFocus onClick={() => ref.current?.close()}>Close</button></div>
    </dialog>,
    document.body,
  );
}
