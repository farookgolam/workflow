// Mounted at /admin/reports, behind requireAuth + requireRole('Admin'): administrators only.
import { Router } from 'express';
import { z } from 'zod';
import { actorFrom, audit } from '../audit/audit';
import { tenantQuery, withTx } from '../db/query';
import { AppError } from '../http/errors';
import { idParam } from '../workflow/routes';
import { safeTimeZone } from './dates';
import { reportCatalog, reportCsv, reportDefinition, reportXlsx, runReport } from './engine';
import { hoursCsv, hoursForms, hoursQuery, hoursSubmitters, hoursTitle, hoursXlsx, runHours } from './hours';

export const adminReportsRouter = Router();

/** The forms a report can be made on (deleted ones are gone; switched-off ones still have their requests). */
adminReportsRouter.get('/forms', async (req, res) => {
  const rows = await tenantQuery<{ FormId: number; Name: string; IsActive: boolean; Requests: number }>(
    req.user!.tenantId,
    `SELECT f.FormId, f.Name, f.IsActive, (SELECT COUNT(*) FROM Requests r WHERE r.TenantId = f.TenantId AND r.FormId = f.FormId) AS Requests
       FROM Forms f WHERE f.TenantId = @TenantId AND f.DeletedAt IS NULL ORDER BY f.Name`,
  );
  res.json({ forms: rows.map((f) => ({ formId: f.FormId, name: f.Name, isActive: f.IsActive, requests: f.Requests })) });
});

adminReportsRouter.get('/catalog', async (req, res) => {
  const formId = idParam(String(req.query.formId ?? ''));
  res.json(await reportCatalog(req.user!.tenantId, formId));
});

adminReportsRouter.post('/run', async (req, res) => {
  const def = reportDefinition.parse(req.body?.definition);
  res.json(await runReport(req.user!.tenantId, def));
});

/** The whole report as a file. Every export is recorded in the audit log, like the audit log's own export. */
adminReportsRouter.post('/export', async (req, res) => {
  const body = z.object({ definition: reportDefinition, format: z.enum(['csv', 'xlsx']), name: z.string().trim().max(200).optional(), timeZone: z.string().max(64).optional() }).parse(req.body);
  const timeZone = safeTimeZone(body.timeZone); // dates with a time are written in the reader's time zone
  const { tenantId } = req.user!;
  const result = await runReport(tenantId, body.definition, { all: true });
  const [form] = await tenantQuery<{ Name: string }>(tenantId, 'SELECT Name FROM Forms WHERE TenantId = @TenantId AND FormId = @F', { F: body.definition.formId });
  const title = body.name || `${form?.Name ?? 'Report'} report`;
  const fileName = `${title.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'report'}_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.${body.format}`;

  await audit(tenantId, actorFrom(req), { action: 'report.exported', entityType: 'Form', entityId: body.definition.formId, detail: { name: title, format: body.format, rows: result.rows.length, definition: body.definition } });
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  if (body.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(reportCsv(result, timeZone));
  } else {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(await reportXlsx(result, title, timeZone));
  }
});

// ---------------------------------------------------------------------------------------
// the Hours report: timesheet lines by submitter and days worked (reports/hours.ts)
// ---------------------------------------------------------------------------------------
adminReportsRouter.get('/hours/forms', async (req, res) => {
  res.json({ forms: await hoursForms(req.user!.tenantId) });
});

adminReportsRouter.get('/hours/submitters', async (req, res) => {
  res.json({ submitters: await hoursSubmitters(req.user!.tenantId, idParam(String(req.query.formId ?? ''))) });
});

adminReportsRouter.post('/hours/run', async (req, res) => {
  res.json(await runHours(req.user!.tenantId, hoursQuery.parse(req.body)));
});

adminReportsRouter.post('/hours/export', async (req, res) => {
  const body = z.object({ query: hoursQuery, format: z.enum(['csv', 'xlsx']) }).parse(req.body);
  const { tenantId } = req.user!;
  const result = await runHours(tenantId, body.query);
  const title = hoursTitle(result);
  const fileName = `${title.replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')}.${body.format}`;
  await audit(tenantId, actorFrom(req), { action: 'report.exported', entityType: 'Form', entityId: body.query.formId, detail: { name: title, format: body.format, rows: result.lineCount, hours: body.query } });
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  if (body.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(hoursCsv(result));
  } else {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(await hoursXlsx(result));
  }
});

// ---------------------------------------------------------------------------------------
// saved reports: every administrator of the organisation sees and can change all of them
// ---------------------------------------------------------------------------------------
const savedBody = z.object({ name: z.string().trim().min(1).max(200), definition: reportDefinition });

adminReportsRouter.get('/saved', async (req, res) => {
  const rows = await tenantQuery<Record<string, any>>(
    req.user!.tenantId,
    `SELECT s.ReportId, s.Name, s.FormId, f.Name AS FormName, s.UpdatedAt, u.DisplayName AS UpdatedBy
       FROM SavedReports s
       LEFT JOIN Forms f ON f.TenantId = s.TenantId AND f.FormId = s.FormId AND f.DeletedAt IS NULL
       LEFT JOIN Users u ON u.TenantId = s.TenantId AND u.UserId = s.UpdatedBy
      WHERE s.TenantId = @TenantId ORDER BY s.Name`,
  );
  res.json({ reports: rows.map((r) => ({ reportId: r.ReportId, name: r.Name, formId: r.FormId, formName: r.FormName ?? '(form deleted)', updatedAt: r.UpdatedAt, updatedBy: r.UpdatedBy })) });
});

adminReportsRouter.get('/saved/:id', async (req, res) => {
  const [r] = await tenantQuery<{ ReportId: number; Name: string; DefinitionJson: string }>(
    req.user!.tenantId, 'SELECT ReportId, Name, DefinitionJson FROM SavedReports WHERE TenantId = @TenantId AND ReportId = @R', { R: idParam(req.params.id) });
  if (!r) throw new AppError(404, 'not_found', 'Report not found');
  res.json({ reportId: r.ReportId, name: r.Name, definition: JSON.parse(r.DefinitionJson) });
});

const nameTaken = () => new AppError(409, 'name_taken', 'A saved report with this name already exists');

adminReportsRouter.post('/saved', async (req, res) => {
  const body = savedBody.parse(req.body);
  const { tenantId, userId } = req.user!;
  const reportId = await withTx(async (tx) => {
    const clash = await tenantQuery(tenantId, 'SELECT 1 AS x FROM SavedReports WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND Name = @Name', { Name: body.name }, tx);
    if (clash.length) throw nameTaken();
    const [{ ReportId }] = await tenantQuery<{ ReportId: number }>(
      tenantId,
      `INSERT INTO SavedReports (TenantId, Name, FormId, DefinitionJson, CreatedBy, UpdatedBy)
       OUTPUT inserted.ReportId VALUES (@TenantId, @Name, @F, @Def, @U, @U)`,
      { Name: body.name, F: body.definition.formId, Def: JSON.stringify(body.definition), U: userId },
      tx,
    );
    await audit(tenantId, actorFrom(req), { action: 'report.saved', entityType: 'Report', entityId: ReportId, detail: { name: body.name, formId: body.definition.formId } }, tx);
    return ReportId;
  });
  res.status(201).json({ reportId });
});

adminReportsRouter.put('/saved/:id', async (req, res) => {
  const body = savedBody.parse(req.body);
  const { tenantId, userId } = req.user!;
  const id = idParam(req.params.id);
  await withTx(async (tx) => {
    const clash = await tenantQuery(tenantId, 'SELECT 1 AS x FROM SavedReports WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND Name = @Name AND ReportId <> @R', { Name: body.name, R: id }, tx);
    if (clash.length) throw nameTaken();
    const done = await tenantQuery(
      tenantId,
      `UPDATE SavedReports SET Name = @Name, FormId = @F, DefinitionJson = @Def, UpdatedBy = @U, UpdatedAt = SYSUTCDATETIME()
       OUTPUT inserted.ReportId WHERE TenantId = @TenantId AND ReportId = @R`,
      { Name: body.name, F: body.definition.formId, Def: JSON.stringify(body.definition), U: userId, R: id },
      tx,
    );
    if (!done.length) throw new AppError(404, 'not_found', 'Report not found');
    await audit(tenantId, actorFrom(req), { action: 'report.updated', entityType: 'Report', entityId: id, detail: { name: body.name } }, tx);
  });
  res.status(204).end();
});

adminReportsRouter.delete('/saved/:id', async (req, res) => {
  const { tenantId } = req.user!;
  const id = idParam(req.params.id);
  await withTx(async (tx) => {
    const gone = await tenantQuery<{ Name: string }>(tenantId, 'DELETE FROM SavedReports OUTPUT deleted.Name WHERE TenantId = @TenantId AND ReportId = @R', { R: id }, tx);
    if (!gone.length) throw new AppError(404, 'not_found', 'Report not found');
    await audit(tenantId, actorFrom(req), { action: 'report.deleted', entityType: 'Report', entityId: id, detail: { name: gone[0].Name } }, tx);
  });
  res.status(204).end();
});
