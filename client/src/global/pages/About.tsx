// About FileBank WorkFlow, for global administrators: what customers see under Help > About, plus what the
// installation runs on - the server, SQL Server and every library with its version and licence.
import { AboutRows, when, type AboutBasics } from '../../about';
import { useGlobalLoad } from '../hooks';

type GlobalAbout = AboutBasics & {
  server: { os: string; host: string; node: string; startedAt: string };
  database: { product: string; version: string; level: string; edition: string; name: string; latestMigration: string | null; migrations: number } | null;
  libraries: { name: string; version: string; licence: string | null; purpose: string | null; part: 'Server' | 'Web pages' }[];
};

export function About() {
  const { data, error } = useGlobalLoad<GlobalAbout>('/about');
  if (error) return <p className="notice bad" role="alert">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  const db = data.database;
  return (
    <div className="stack">
      <h1>About</h1>
      <section className="card">
        <img src="/filebank-logo.png" alt="FileBank" className="about-logo" />
        <table className="about-table" style={{ marginTop: '1rem' }}><tbody><AboutRows about={data} /></tbody></table>
      </section>

      <section className="card">
        <h2>Server</h2>
        <table className="about-table"><tbody>
          <tr><th scope="row">Operating system</th><td>{data.server.os}</td></tr>
          <tr><th scope="row">Computer name</th><td>{data.server.host}</td></tr>
          <tr><th scope="row">Node.js</th><td>{data.server.node}</td></tr>
          <tr><th scope="row">Running since</th><td>{when(data.server.startedAt)}</td></tr>
        </tbody></table>
      </section>

      <section className="card">
        <h2>Database</h2>
        {db ? (
          <table className="about-table"><tbody>
            <tr><th scope="row">SQL Server</th><td>{db.product}</td></tr>
            <tr><th scope="row">Version</th><td>{db.version} ({db.level})</td></tr>
            <tr><th scope="row">Edition</th><td>{db.edition}</td></tr>
            <tr><th scope="row">Database</th><td>{db.name}</td></tr>
            <tr><th scope="row">Latest migration</th><td>{db.latestMigration ?? '—'} ({db.migrations} applied)</td></tr>
          </tbody></table>
        ) : <p className="muted">The database could not be asked for its version.</p>}
      </section>

      <section className="card">
        <h2>Software used to build the application</h2>
        <p className="muted small">Versions are the ones installed on this server.</p>
        <table>
          <thead><tr><th>Part</th><th>Software</th><th>Version</th><th>Used for</th><th>Licence</th></tr></thead>
          <tbody>
            {data.libraries.map((l) => (
              <tr key={`${l.part}-${l.name}`}><td>{l.part}</td><td className="mono">{l.name}</td><td>{l.version}</td><td>{l.purpose ?? ''}</td><td>{l.licence ?? '—'}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
