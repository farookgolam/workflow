// "About FileBank WorkFlow": the application's name, version, when it was last updated and how to reach FileBank.
// Everyone signed in sees that much (GET /about). Global administrators also see what it runs on - the server, the
// SQL Server version and every library with its version and licence (GET /global/about). That detail is kept from
// customers on purpose: an exact list of versions is the first thing an attacker looks for.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import { requireAuth } from '../auth/middleware';
import { config } from '../config';
import { unscopedQuery } from '../db/query';
import { requirePlatformAdmin } from '../platform/identity';

export const PRODUCT = 'FileBank WorkFlow';
export const CONTACT = { website: 'https://filebankinc.com', websiteLabel: 'filebankinc.com', phone: '973-279-4411' };

// The server runs in <app>/server; the app root is one level up (as MANUALS_DIR assumes).
const APP_ROOT = path.resolve(config.manualsDir, '..', '..');

export type Release = { version: string; updatedAt: string | null };

/**
 * Which version this is and when it was installed. scripts/azure-vm-update.ps1 writes DEPLOYED.txt to the app root
 * on every update: "v1.0.22 (ref 46745b9) - installed 2026-10-02 16:00" (the server's own clock). Without it - a
 * development copy - the version is "development" and the date is when the server code was last changed.
 */
export function release(root = APP_ROOT): Release {
  try {
    const text = fs.readFileSync(path.join(root, 'DEPLOYED.txt'), 'utf8').trim();
    const m = text.match(/^(.*?)\s+-\s+installed\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
    if (m) {
      const version = m[1].match(/^(v[\d.]+\S*)/)?.[1] ?? m[1];
      const at = new Date(`${m[2]}T${m[3]}:00`); // local time on the server
      return { version, updatedAt: Number.isNaN(at.getTime()) ? null : at.toISOString() };
    }
  } catch { /* no DEPLOYED.txt: a development copy */ }
  try {
    return { version: 'development', updatedAt: fs.statSync(path.join(root, 'server', 'package.json')).mtime.toISOString() };
  } catch {
    return { version: 'development', updatedAt: null };
  }
}

function basics() {
  return { product: PRODUCT, ...release(), contact: CONTACT };
}

// what each library is for, in plain words (anything not listed is still shown, without a note)
const PURPOSE: Record<string, string> = {
  express: 'Web server', helmet: 'Security headers', 'express-rate-limit': 'Sign-in rate limiting', 'cookie-parser': 'Session cookie',
  jsonwebtoken: 'Sign-in tokens', zod: 'Input checking', mssql: 'SQL Server connection', msnodesqlv8: 'SQL Server driver (Windows sign-in)',
  pdfkit: 'PDF records', exceljs: 'Excel import and export', archiver: 'ZIP exports', nodemailer: 'Email', 'node-html-parser': 'HTML form import',
  dotenv: 'Configuration', react: 'User interface', 'react-dom': 'User interface', 'react-router-dom': 'Page navigation',
  '@fontsource-variable/archivo': 'Archivo typeface', vite: 'Builds the web pages', typescript: 'Programming language',
};

type Library = { name: string; version: string; licence: string | null; purpose: string | null; part: 'Server' | 'Web pages' };

function libraries(): Library[] {
  const out: Library[] = [];
  for (const [dir, part] of [['server', 'Server'], ['client', 'Web pages']] as const) {
    let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try { pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, dir, 'package.json'), 'utf8')); } catch { continue; }
    const names = Object.keys(pkg.dependencies ?? {});
    if (dir === 'client') names.push(...['vite', 'typescript'].filter((n) => pkg.devDependencies?.[n])); // what builds the pages
    for (const name of names) {
      const wanted = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? '';
      let installed: { version?: string; license?: string } = {};
      try { installed = JSON.parse(fs.readFileSync(path.join(APP_ROOT, dir, 'node_modules', name, 'package.json'), 'utf8')); } catch { /* not installed here */ }
      out.push({ name, version: installed.version ?? wanted.replace(/^[\^~]/, ''), licence: installed.license ?? null, purpose: PURPOSE[name] ?? null, part });
    }
  }
  return out;
}

async function database() {
  try {
    const [row] = await unscopedQuery<{ Version: string; Level: string; Edition: string; Product: string; Db: string }>(
      `SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS Version, CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(128)) AS Level,
              CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS Edition, LEFT(@@VERSION, CHARINDEX(' (', @@VERSION + ' (') - 1) AS Product, DB_NAME() AS Db`,
    );
    const migrations = await unscopedQuery<{ Name: string }>('SELECT Name FROM SchemaMigrations');
    const latest = migrations.map((m) => m.Name).sort().at(-1) ?? null;
    return { product: row.Product, version: row.Version, level: row.Level, edition: row.Edition, name: row.Db, latestMigration: latest, migrations: migrations.length };
  } catch {
    return null; // the page still shows everything else
  }
}

/** Everyone signed in at a customer's address. */
export const aboutRouter = Router();
aboutRouter.get('/', requireAuth, (_req, res) => {
  res.json(basics());
});

/** Global administrators: the same, plus what the application runs on and is built with. */
export const globalAboutRouter = Router();
globalAboutRouter.get('/', requirePlatformAdmin, async (_req, res) => {
  res.json({
    ...basics(),
    server: {
      os: `${os.version()} (${os.release()})`,
      host: os.hostname(),
      node: process.version,
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    },
    database: await database(),
    libraries: libraries(),
  });
});
