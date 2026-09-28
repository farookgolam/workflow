// A customer's own file folder (Tenants.FileStorageRoot, migration 025).
//
// When a global administrator sets one, that customer's new closed-request PDFs and approvers' attachments are
// written there as ordinary files - one sub-folder per day, the day the request was submitted, holding every file of
// the requests submitted that day - and the database keeps only the path and the file's SHA-256. Reading always checks the fingerprint: a file changed or damaged outside the app is refused.
// The Windows account the app runs as needs Modify permission on the folder (and the share, for a UNC path).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tenantQuery } from '../db/query';
import { AppError } from '../http/errors';

/** The customer's folder, or null when its files are kept in the database. */
export async function fileRootFor(tenantId: number): Promise<string | null> {
  const [t] = await tenantQuery<{ FileStorageRoot: string | null }>(tenantId, 'SELECT FileStorageRoot FROM Tenants WHERE TenantId = @TenantId');
  return t?.FileStorageRoot ?? null;
}

const DRIVE = /^[A-Za-z]:\\[^\\]/; // D:\Something - a whole drive is not accepted
const UNC = /^\\\\[^\\]+\\[^\\]+/; // \\server\share[\folder]

/**
 * Checks a folder a global administrator typed and proves the app can use it: it is created if missing, and a
 * probe file is written and deleted. Returns the normalised path.
 */
export async function checkFileRoot(input: string): Promise<string> {
  const raw = input.trim().replace(/\//g, '\\').replace(/\\+$/, '');
  const bad = (m: string) => new AppError(400, 'validation_failed', 'Invalid input', [{ path: 'fileStorageRoot', message: m }]);
  if (!DRIVE.test(raw) && !UNC.test(raw)) throw bad('Use a full folder path such as D:\\CustomerFiles\\Acme or \\\\server\\share\\Acme (not a whole drive)');
  if (raw.split('\\').some((p) => p === '..' || p === '.')) throw bad('The path may not contain "." or ".." parts');
  if (raw.length > 300) throw bad('The path is too long');
  const root = path.win32.normalize(raw);

  const probe = path.join(root, `.approvalflow-check-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.writeFile(probe, 'ok', { flag: 'wx' });
    await fs.promises.unlink(probe);
  } catch (e) {
    throw bad(`The app cannot write to that folder (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}). Check it exists or can be created, and that the account the app runs as has Modify permission on it.`);
  }
  return root;
}

/**
 * The folder for the requests submitted on a day: 2026-09-28. The day is the server's own (its Windows time zone),
 * so a request submitted late in the evening is not filed under the next day.
 */
export function dayFolder(submittedAt: Date): string {
  const d = new Date(submittedAt);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A file or folder name Windows accepts, from any text. */
export const safeName = (s: string) =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 150) || 'file';

/**
 * Writes a new file under the customer's folder, never over an existing one: a name already taken gets " (2)",
 * " (3)"… Returns the full path and the fingerprint to keep in the database.
 */
export async function writeCustomerFile(root: string, folders: string[], fileName: string, content: Buffer): Promise<{ filePath: string; sha: Buffer }> {
  const dir = path.join(root, ...folders.map(safeName));
  if (!dir.startsWith(root)) throw new Error('File path escapes the customer folder');
  await fs.promises.mkdir(dir, { recursive: true });
  const name = safeName(fileName);
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; i <= 50; i++) {
    const filePath = path.join(dir, i === 1 ? name : `${base} (${i})${ext}`);
    try {
      await fs.promises.writeFile(filePath, content, { flag: 'wx' });
      return { filePath, sha: crypto.createHash('sha256').update(content).digest() };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`Too many files called "${name}" in ${dir}`);
}

/** Reads a stored file and refuses it unless it is exactly what was stored. */
export async function readCustomerFile(filePath: string, sha: Buffer): Promise<Buffer> {
  let content: Buffer;
  try {
    content = await fs.promises.readFile(filePath);
  } catch {
    throw new AppError(410, 'file_missing', 'The stored file is missing from the customer\'s file folder. Ask the administrator to restore it from a backup.');
  }
  if (!crypto.createHash('sha256').update(content).digest().equals(sha)) {
    throw new AppError(409, 'file_changed', 'The stored file has been changed outside the app since it was saved, so it is not shown. Ask the administrator to restore it from a backup.');
  }
  return content;
}

/** Best effort: removes a file, then its folder and the one above if they are now empty (never the customer folder itself). */
export async function removeCustomerFile(filePath: string, root?: string | null): Promise<void> {
  await fs.promises.unlink(filePath).catch(() => {});
  let dir = path.dirname(filePath);
  for (let i = 0; i < 2 && (!root || (dir !== root && dir.startsWith(root))); i++) {
    try {
      await fs.promises.rmdir(dir); // fails unless empty
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}
