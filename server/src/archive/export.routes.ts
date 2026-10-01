import type { Response } from 'express';
import { Router } from 'express';
import { actorFrom, audit } from '../audit/audit';
import { exportQuery, previewExport, writeExport, type ExportQuery } from './export';

/**
 * Streams the export ZIP. Anything wrong with the request (no form, nothing or too much to export) is refused as a
 * normal JSON error before a byte is sent; a failure part-way through can only cut the download short.
 */
export async function sendExport(res: Response, tenantId: number, q: ExportQuery): Promise<number> {
  try {
    return await writeExport(tenantId, q, res, (fileName) => {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/[^\w.-]/g, '_')}"`);
      res.setHeader('Cache-Control', 'private, no-store');
    });
  } catch (err) {
    if (res.headersSent) { res.destroy(err as Error); return 0; }
    throw err;
  }
}

/** Mounted at /admin/exports (behind requireAuth + Admin): the customer's own PDFs. */
export const adminExportRouter = Router();

adminExportRouter.get('/pdfs/preview', async (req, res) => {
  res.json(await previewExport(req.user!.tenantId, exportQuery.parse(req.query)));
});

adminExportRouter.get('/pdfs', async (req, res) => {
  const q = exportQuery.parse(req.query);
  const count = await sendExport(res, req.user!.tenantId, q);
  if (count) await audit(req.user!.tenantId, actorFrom(req), { action: 'pdf.exported', entityType: 'Form', entityId: q.formId, detail: { ...q, files: count } });
});
