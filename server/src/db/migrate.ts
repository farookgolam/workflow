import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';
import { connectionConfig, sql } from './pool';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

/** Creates the database if needed and applies pending migrations/NNN_*.sql in order. */
export async function migrate(opts: { recreate?: boolean; log?: (m: string) => void } = {}): Promise<void> {
  const log = opts.log ?? console.log;
  const dbName = config.db.name; // validated as [A-Za-z0-9_]+ in config

  const master = await new sql.ConnectionPool(connectionConfig('master')).connect();
  try {
    if (opts.recreate) {
      if (!config.isTest || !/_test$/i.test(dbName)) {
        throw new Error('Refusing to recreate a database unless NODE_ENV=test and DB_NAME ends with _Test');
      }
      await master.request().query(
        `IF DB_ID('${dbName}') IS NOT NULL BEGIN
           ALTER DATABASE [${dbName}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
           DROP DATABASE [${dbName}];
         END`,
      );
    }
    const exists = await master.request().query(`SELECT DB_ID('${dbName}') AS id`);
    if (exists.recordset[0].id === null) {
      await master.request().query(`CREATE DATABASE [${dbName}]`);
      log(`Created database ${dbName}`);
    }
  } finally {
    await master.close();
  }

  const pool = await new sql.ConnectionPool(connectionConfig(dbName)).connect();
  try {
    await pool.request().query(
      `IF OBJECT_ID('SchemaMigrations') IS NULL
         CREATE TABLE SchemaMigrations (
           Name NVARCHAR(200) NOT NULL PRIMARY KEY,
           AppliedAt DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME())`,
    );
    const applied = new Set(
      (await pool.request().query('SELECT Name FROM SchemaMigrations')).recordset.map((r: { Name: string }) => r.Name),
    );
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const batches = fs
        .readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
        .split(/^\s*GO\s*$/im)
        .map((b) => b.trim())
        .filter(Boolean);
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        for (const batch of batches) await new sql.Request(tx).batch(batch);
        await new sql.Request(tx).input('Name', file).query('INSERT INTO SchemaMigrations (Name) VALUES (@Name)');
        await tx.commit();
        log(`Applied ${file}`);
      } catch (err) {
        try {
          await tx.rollback();
        } catch {
          /* already rolled back */
        }
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
    log('Database is up to date.');
  } finally {
    await pool.close();
  }
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
