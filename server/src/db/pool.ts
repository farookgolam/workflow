import type * as MsSql from 'mssql';
import { config } from '../config';

// Windows auth needs the ODBC-based driver; SQL logins use the pure-JS tedious driver.
// Both expose the same mssql API.
export const sql: typeof MsSql =
  config.db.auth === 'windows' ? require('mssql/msnodesqlv8') : require('mssql');

export function connectionConfig(database: string): MsSql.config {
  if (config.db.auth === 'windows') {
    return {
      connectionString:
        `Driver={${config.db.odbcDriver}};Server=${config.db.server};Database=${database};` +
        'Trusted_Connection=yes;TrustServerCertificate=yes;',
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    } as unknown as MsSql.config;
  }
  const [host, instanceName] = config.db.server.split('\\');
  return {
    server: host === '.' ? 'localhost' : host,
    database,
    user: config.db.user,
    password: config.db.password,
    options: { instanceName, encrypt: true, trustServerCertificate: true },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  };
}

let poolPromise: Promise<MsSql.ConnectionPool> | null = null;

export function getPool(): Promise<MsSql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(connectionConfig(config.db.name)).connect().catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

export async function closePool(): Promise<void> {
  if (poolPromise) {
    const p = await poolPromise;
    poolPromise = null;
    await p.close();
  }
}
