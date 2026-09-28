// Archive pipeline, identical for Approved and Rejected requests:
//   PdfPending --(PDF made and stored in RequestDocuments)--> Stored
// For a customer with its own file folder (migration 025) the PDF itself is written there and the row keeps
// only its path and fingerprint.
// It runs AFTER the decision transaction has committed, so the submitter's notification is
// already in the outbox - nothing here can delay or block it. The PDF is kept only in the database;
// earlier versions also uploaded it to SharePoint (the statuses PendingUpload / Uploaded / Failed of
// requests from that time were turned into Stored by migration 021).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { audit, systemActor } from '../audit/audit';
import { config } from '../config';
import { tenantQuery, unscopedQuery, withTx, type Tx } from '../db/query';
import { dayFolder, fileRootFor, readCustomerFile, removeCustomerFile, writeCustomerFile } from '../customer-files/files';
import { loadRequestDetail } from '../workflow/read';
import { archiveFileName, buildRequestPdf, type AuditRow } from './pdf';

const LEASE_MINUTES = 10;

/** Before PDFs were kept in the database they lived under STORAGE_DIR/pdf/<tenantId>/; see backfillPdfFiles. */
export const pdfAbsolutePath = (relative: string) => {
  const root = path.join(config.storageDir, 'pdf');
  const abs = path.resolve(root, relative);
  if (!abs.startsWith(root + path.sep)) throw new Error('PDF path escapes the storage directory');
  return abs;
};

interface Candidate { TenantId: number; RequestId: number }

async function candidates(tenantId?: number): Promise<Candidate[]> {
  return unscopedQuery<Candidate>(
    `SELECT TOP 25 TenantId, RequestId FROM Requests
      WHERE ArchiveStatus = 'PdfPending' AND (NextUploadAttemptAt IS NULL OR NextUploadAttemptAt <= SYSUTCDATETIME())
        AND (@Tenant IS NULL OR TenantId = @Tenant)
      ORDER BY ClosedAt`,
    { Tenant: tenantId ?? null },
  );
}

/** Takes a short lease so two workers (or a crash) never process the same request twice at once. */
async function claim(c: Candidate): Promise<boolean> {
  const [{ n }] = await tenantQuery<{ n: number }>(
    c.TenantId,
    `UPDATE Requests SET NextUploadAttemptAt = DATEADD(MINUTE, @Lease, SYSUTCDATETIME())
      WHERE TenantId = @TenantId AND RequestId = @RequestId AND ArchiveStatus = 'PdfPending'
        AND (NextUploadAttemptAt IS NULL OR NextUploadAttemptAt <= SYSUTCDATETIME());
     SELECT @@ROWCOUNT AS n;`,
    { Lease: LEASE_MINUTES, RequestId: c.RequestId },
  );
  return n === 1;
}

async function generatePdf(c: Candidate): Promise<void> {
  const detail = await loadRequestDetail(c.TenantId, c.RequestId);
  if (!detail) return;
  const rows = await tenantQuery<Record<string, any>>(
    c.TenantId,
    `SELECT a.OccurredAt, a.Action, u.DisplayName, a.IpAddress, a.FromState, a.ToState
       FROM AuditLog a LEFT JOIN Users u ON u.TenantId = a.TenantId AND u.UserId = a.UserId
      WHERE a.TenantId = @TenantId AND a.RequestId = @RequestId
        AND a.Action NOT LIKE 'archive.%' AND a.Action NOT LIKE 'pdf.%' -- the workflow itself, not the housekeeping after it
      ORDER BY a.AuditId`,
    { RequestId: c.RequestId },
  );
  const auditRows: AuditRow[] = rows.map((r) => ({ occurredAt: r.OccurredAt, action: r.Action, userName: r.DisplayName, ip: r.IpAddress, fromState: r.FromState, toState: r.ToState }));

  const pdf = await buildRequestPdf(detail, auditRows);
  const fileName = archiveFileName(detail);
  const sha = crypto.createHash('sha256').update(pdf).digest();

  // in the customer's folder if it has one: written first, and removed again if the database part fails
  const root = await fileRootFor(c.TenantId);
  const onDisk = root ? await writeCustomerFile(root, [dayFolder(detail.submittedAt)], fileName, pdf) : null;
  try {
    await withTx(async (tx) => {
      await storeDocument(c.TenantId, c.RequestId, fileName, pdf, sha, tx, onDisk?.filePath ?? null);
      await tenantQuery(
        c.TenantId,
        `UPDATE Requests SET ArchiveStatus = 'Stored', PdfSha256 = @Sha, NextUploadAttemptAt = NULL
          WHERE TenantId = @TenantId AND RequestId = @RequestId AND ArchiveStatus = 'PdfPending'`,
        { Sha: sha, RequestId: c.RequestId },
        tx,
      );
      await audit(c.TenantId, systemActor, { action: 'archive.pdf_stored', entityType: 'Request', entityId: c.RequestId, requestId: c.RequestId, fromState: 'PdfPending', toState: 'Stored', detail: { file: fileName, bytes: pdf.length, ...(onDisk ? { path: onDisk.filePath } : {}) } }, tx);
    });
  } catch (err) {
    if (onDisk) await removeCustomerFile(onDisk.filePath, root);
    throw err;
  }
}

/**
 * Keeps a request's PDF in RequestDocuments, where it can never be changed (see migration 019): the bytes
 * themselves, or - with `filePath` - where they were written in the customer's folder.
 */
async function storeDocument(tenantId: number, requestId: number, fileName: string, pdf: Buffer, sha: Buffer, tx: Tx, filePath: string | null = null): Promise<void> {
  const [{ n }] = await tenantQuery<{ n: number }>(
    tenantId,
    `IF NOT EXISTS (SELECT 1 FROM RequestDocuments WHERE TenantId = @TenantId AND RequestId = @RequestId)
       INSERT INTO RequestDocuments (TenantId, RequestId, FileName, SizeBytes, Sha256, Content, FilePath)
       VALUES (@TenantId, @RequestId, @File, @Size, @Sha, CAST(@Content AS VARBINARY(MAX)), @Path); -- a NULL is bound as text
     SELECT @@ROWCOUNT AS n;`,
    { RequestId: requestId, File: fileName, Size: pdf.length, Sha: sha, Content: filePath ? null : pdf, Path: filePath },
    tx,
  );
  // already stored by an earlier run: the file just written is not the record, so it must not stay behind
  if (n === 0 && filePath) throw new Error('This request already has a stored PDF');
}

/** A request's stored PDF: from the database, or - for a request archived before 019 and not copied yet - from the old file. */
export async function loadDocument(tenantId: number, requestId: number): Promise<{ fileName: string; content: Buffer } | null> {
  const [d] = await tenantQuery<{ FileName: string; Content: Buffer | null; FilePath: string | null; Sha256: Buffer }>(
    tenantId,
    'SELECT FileName, Content, FilePath, Sha256 FROM RequestDocuments WHERE TenantId = @TenantId AND RequestId = @RequestId',
    { RequestId: requestId },
  );
  if (d) return { fileName: d.FileName, content: d.FilePath ? await readCustomerFile(d.FilePath, d.Sha256) : d.Content! };
  const [r] = await tenantQuery<{ PdfLocalPath: string | null }>(tenantId, 'SELECT PdfLocalPath FROM Requests WHERE TenantId = @TenantId AND RequestId = @RequestId', { RequestId: requestId });
  if (!r?.PdfLocalPath) return null;
  const file = pdfAbsolutePath(r.PdfLocalPath);
  return fs.existsSync(file) ? { fileName: path.basename(file), content: await fs.promises.readFile(file) } : null;
}

/**
 * Copies PDFs archived before 019 (files under STORAGE_DIR/pdf) into the database. Each file must still have
 * the fingerprint recorded when it was made; one that does not is left alone and reported. Safe to run again.
 */
export async function backfillPdfFiles(): Promise<{ copied: number; skipped: string[] }> {
  const rows = await unscopedQuery<{ TenantId: number; RequestId: number; PdfLocalPath: string; PdfSha256: Buffer | null }>(
    `SELECT r.TenantId, r.RequestId, r.PdfLocalPath, r.PdfSha256 FROM Requests r
      WHERE r.PdfLocalPath IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM RequestDocuments d WHERE d.TenantId = r.TenantId AND d.RequestId = r.RequestId)`,
  );
  const out = { copied: 0, skipped: [] as string[] };
  for (const r of rows) {
    const file = pdfAbsolutePath(r.PdfLocalPath);
    if (!fs.existsSync(file)) { out.skipped.push(`${r.PdfLocalPath} (missing)`); continue; }
    const pdf = await fs.promises.readFile(file);
    const sha = crypto.createHash('sha256').update(pdf).digest();
    if (r.PdfSha256 && !sha.equals(r.PdfSha256)) { out.skipped.push(`${r.PdfLocalPath} (changed since it was archived)`); continue; }
    await withTx(async (tx) => {
      await storeDocument(r.TenantId, r.RequestId, path.basename(file), pdf, sha, tx);
      await audit(r.TenantId, systemActor, { action: 'archive.pdf_copied_to_database', entityType: 'Request', entityId: r.RequestId, requestId: r.RequestId, detail: { file: path.basename(file), bytes: pdf.length } }, tx);
    });
    out.copied++;
  }
  return out;
}

/** Makes and stores the PDF of every request that has just closed. */
export async function processArchive(opts: { tenantId?: number } = {}): Promise<{ generated: number }> {
  const out = { generated: 0 };
  for (const c of await candidates(opts.tenantId)) {
    if (!(await claim(c))) continue;
    try {
      await generatePdf(c);
      out.generated++;
    } catch (err) {
      // the lease expires in a few minutes and the request is picked up again
      console.error(`[archive-worker] PDF generation failed for request ${c.RequestId}:`, (err as Error).message);
    }
  }
  return out;
}

export function startArchiveWorker(intervalMs = 15_000): () => void {
  let running = false;
  let backfilled = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      if (!backfilled) {
        const b = await backfillPdfFiles();
        backfilled = true;
        if (b.copied || b.skipped.length) console.log(`[archive-worker] copied ${b.copied} earlier PDF file(s) into the database${b.skipped.length ? `; not copied: ${b.skipped.join(', ')}` : ''}`);
      }
      await processArchive();
    } catch (err) {
      console.error('[archive-worker]', (err as Error).message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  void tick();
  console.log("Archive worker started (PDFs of closed requests are kept in the database, or in a customer's own file folder)");
  return () => clearInterval(timer);
}
