import { Router } from 'express';
import { z } from 'zod';
import { actorFrom, audit } from '../audit/audit';
import { tenantQuery, type Params } from '../db/query';
import { AppError } from '../http/errors';
import { reassignStep, remindStep } from '../workflow/engine';
import { loadRequestDetail } from '../workflow/read';
import { idParam } from '../workflow/routes';

// Everything here is mounted behind requireAuth + requireRole('Admin').
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const optionalId = z.coerce.number().int().positive().optional();
const likeEscape = (s: string) => `%${s.replace(/[\\%_[]/g, (c) => `\\${c}`)}%`;
const OVERDUE = `EXISTS (SELECT 1 FROM RequestSteps o WHERE o.TenantId = r.TenantId AND o.RequestId = r.RequestId AND o.Status = 'Active' AND o.DueAt < SYSUTCDATETIME())`;

// ---------------------------------------------------------------------------------------
export const dashboardRouter = Router();

dashboardRouter.get('/', async (req, res) => {
  const { tenantId } = req.user!;
  const [c] = await tenantQuery<Record<string, number>>(
    tenantId,
    `SELECT SUM(CASE WHEN r.Status = 'InProgress' THEN 1 ELSE 0 END) AS InProgress,
            SUM(CASE WHEN r.Status = 'Approved' THEN 1 ELSE 0 END) AS Approved,
            SUM(CASE WHEN r.Status = 'Rejected' THEN 1 ELSE 0 END) AS Rejected,
            SUM(CASE WHEN r.Status = 'Cancelled' THEN 1 ELSE 0 END) AS Cancelled,
            SUM(CASE WHEN r.Status = 'InProgress' AND od.IsOverdue = 1 THEN 1 ELSE 0 END) AS Overdue
       FROM Requests r
       OUTER APPLY (SELECT CASE WHEN ${OVERDUE} THEN 1 ELSE 0 END AS IsOverdue) od
      WHERE r.TenantId = @TenantId`,
  );
  const steps = await tenantQuery<Record<string, any>>(
    tenantId,
    `SELECT f.Name AS FormName, rs.StepOrder, rs.StepName, COUNT(*) AS Decisions,
            AVG(CAST(DATEDIFF(MINUTE, rs.ActivatedAt, rs.ActedAt) AS FLOAT)) / 60.0 AS AvgHours
       FROM RequestSteps rs
       JOIN Requests r ON r.TenantId = rs.TenantId AND r.RequestId = rs.RequestId
       JOIN Forms f ON f.TenantId = r.TenantId AND f.FormId = r.FormId
      WHERE rs.TenantId = @TenantId AND rs.ActedAt IS NOT NULL AND rs.ActivatedAt IS NOT NULL
      GROUP BY f.Name, rs.StepOrder, rs.StepName
      ORDER BY f.Name, rs.StepOrder`,
  );
  const [mail] = await tenantQuery<{ Failed: number }>(tenantId, `SELECT COUNT(*) AS Failed FROM Notifications WHERE TenantId = @TenantId AND Status = 'Failed'`);
  res.json({
    counts: { inProgress: c.InProgress ?? 0, approved: c.Approved ?? 0, rejected: c.Rejected ?? 0, cancelled: c.Cancelled ?? 0, overdue: c.Overdue ?? 0 },
    failedNotifications: mail.Failed,
    averageTimePerStep: steps.map((s) => ({ formName: s.FormName, stepOrder: s.StepOrder, stepName: s.StepName, decisions: s.Decisions, avgHours: Math.round(Number(s.AvgHours) * 10) / 10 })),
  });
});

// ---------------------------------------------------------------------------------------
export const adminRequestListRouter = Router();

const listQuery = z.object({
  formId: optionalId,
  status: z.enum(['InProgress', 'Approved', 'Rejected', 'Cancelled', 'Overdue']).optional(),
  submitter: optionalId,
  approver: optionalId,
  from: day.optional(),
  to: day.optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

adminRequestListRouter.get('/', async (req, res) => {
  const f = listQuery.parse(req.query);
  const where = ['r.TenantId = @TenantId'];
  const params: Params = { Offset: (f.page - 1) * f.pageSize, Size: f.pageSize };
  if (f.formId) (where.push('r.FormId = @FormId'), (params.FormId = f.formId));
  if (f.status === 'Overdue') where.push(`r.Status = 'InProgress' AND ${OVERDUE}`);
  else if (f.status) (where.push('r.Status = @Status'), (params.Status = f.status));
  if (f.submitter) (where.push('r.SubmitterUserId = @Submitter'), (params.Submitter = f.submitter));
  if (f.approver) {
    where.push(`EXISTS (SELECT 1 FROM RequestSteps a WHERE a.TenantId = r.TenantId AND a.RequestId = r.RequestId
                 AND (a.AssignedUserId = @Approver OR a.DelegateUserId = @Approver OR a.ActedByUserId = @Approver))`);
    params.Approver = f.approver;
  }
  if (f.from) (where.push('r.SubmittedAt >= @From'), (params.From = f.from));
  if (f.to) (where.push('r.SubmittedAt < DATEADD(DAY, 1, CAST(@To AS DATE))'), (params.To = f.to));
  if (f.q) {
    where.push(`(r.RequestNumber LIKE @Q ESCAPE '\\' OR su.DisplayName LIKE @Q ESCAPE '\\' OR su.Email LIKE @Q ESCAPE '\\'
                 OR EXISTS (SELECT 1 FROM RequestData d WHERE d.TenantId = r.TenantId AND d.RequestId = r.RequestId AND d.Value LIKE @Q ESCAPE '\\'))`);
    params.Q = likeEscape(f.q);
  }

  const rows = await tenantQuery<Record<string, any>>(
    req.user!.tenantId,
    `SELECT r.RequestId, r.RequestNumber, f.Name AS FormName, r.Status, r.ArchiveStatus, r.CurrentStepOrder, r.TotalSteps, r.SubmittedAt, r.ClosedAt,
            su.DisplayName AS SubmitterName, CASE WHEN cs.Status = 'Returned' THEN su.DisplayName + N' (sent back for changes)' ELSE cu.DisplayName END AS WaitingOn, cs.DueAt,
            CASE WHEN cs.Status = 'Active' AND cs.DueAt < SYSUTCDATETIME() THEN 1 ELSE 0 END AS IsOverdue, COUNT(*) OVER () AS Total
       FROM Requests r
       JOIN Forms f ON f.TenantId = r.TenantId AND f.FormId = r.FormId
       JOIN Users su ON su.TenantId = r.TenantId AND su.UserId = r.SubmitterUserId
       LEFT JOIN RequestSteps cs ON cs.TenantId = r.TenantId AND cs.RequestId = r.RequestId AND cs.Status IN ('Active','Returned')
       LEFT JOIN Users cu ON cu.TenantId = cs.TenantId AND cu.UserId = cs.AssignedUserId
      WHERE ${where.join(' AND ')}
      ORDER BY r.SubmittedAt DESC, r.RequestId DESC
      OFFSET @Offset ROWS FETCH NEXT @Size ROWS ONLY`,
    params,
  );
  res.json({
    total: rows[0]?.Total ?? 0,
    page: f.page,
    pageSize: f.pageSize,
    requests: rows.map((r) => ({
      requestId: r.RequestId, requestNumber: r.RequestNumber, formName: r.FormName, status: r.Status, archiveStatus: r.ArchiveStatus,
      currentStep: r.CurrentStepOrder, totalSteps: r.TotalSteps, submitterName: r.SubmitterName, waitingOn: r.WaitingOn,
      submittedAt: r.SubmittedAt, closedAt: r.ClosedAt, dueAt: r.DueAt, overdue: r.IsOverdue === 1,
    })),
  });
});

/** Full timeline: submission, every step with who acted / when / what they entered, audit trail, emails, archive state. */
adminRequestListRouter.get('/:id', async (req, res) => {
  const { tenantId } = req.user!;
  const requestId = idParam(req.params.id);
  const detail = await loadRequestDetail(tenantId, requestId);
  if (!detail) throw new AppError(404, 'not_found', 'Request not found');
  const [archive] = await tenantQuery<Record<string, any>>(
    tenantId,
    `SELECT r.ArchiveStatus, CASE WHEN EXISTS (SELECT 1 FROM RequestDocuments d WHERE d.TenantId = r.TenantId AND d.RequestId = r.RequestId) OR r.PdfLocalPath IS NOT NULL THEN 1 ELSE 0 END AS PdfAvailable,
            (SELECT d.SizeBytes FROM RequestDocuments d WHERE d.TenantId = r.TenantId AND d.RequestId = r.RequestId) AS PdfBytes,
            (SELECT CASE WHEN d.FilePath IS NULL THEN 0 ELSE 1 END FROM RequestDocuments d WHERE d.TenantId = r.TenantId AND d.RequestId = r.RequestId) AS PdfInFolder
       FROM Requests r WHERE r.TenantId = @TenantId AND r.RequestId = @R`,
    { R: requestId },
  );
  const auditRows = await tenantQuery<Record<string, any>>(
    tenantId,
    `SELECT a.AuditId, a.OccurredAt, a.Action, a.FromState, a.ToState, a.IpAddress, a.DetailJson, u.DisplayName
       FROM AuditLog a LEFT JOIN Users u ON u.TenantId = a.TenantId AND u.UserId = a.UserId
      WHERE a.TenantId = @TenantId AND a.RequestId = @R ORDER BY a.AuditId`,
    { R: requestId },
  );
  const mails = await tenantQuery<Record<string, any>>(
    tenantId,
    'SELECT NotificationId, Type, RecipientEmail, Subject, Status, Attempts, CreatedAt, SentAt, LastError FROM Notifications WHERE TenantId = @TenantId AND RequestId = @R ORDER BY NotificationId',
    { R: requestId },
  );
  res.json({
    request: detail,
    archive: {
      status: archive.ArchiveStatus, pdfAvailable: archive.PdfAvailable === 1, pdfBytes: archive.PdfBytes,
      // the organisation's own file folder rather than the database (the path itself is not shown to customers)
      pdfInFolder: archive.PdfInFolder === 1,
    },
    audit: auditRows.map((a) => ({ auditId: a.AuditId, occurredAt: a.OccurredAt, action: a.Action, fromState: a.FromState, toState: a.ToState, ip: a.IpAddress, user: a.DisplayName ?? 'System', detail: a.DetailJson ? JSON.parse(a.DetailJson) : null })),
    notifications: mails.map((m) => ({ notificationId: m.NotificationId, type: m.Type, to: m.RecipientEmail, subject: m.Subject, status: m.Status, attempts: m.Attempts, createdAt: m.CreatedAt, sentAt: m.SentAt, lastError: m.LastError })),
  });
});

const stepOf = async (tenantId: number, requestId: number, requestStepId: number) => {
  const rows = await tenantQuery(tenantId, 'SELECT 1 AS x FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R AND RequestStepId = @S', { R: requestId, S: requestStepId });
  if (!rows.length) throw new AppError(404, 'not_found', 'That step does not belong to this request');
};

adminRequestListRouter.post('/:id/reassign', async (req, res) => {
  const body = z.object({ requestStepId: z.number().int().positive(), newUserId: z.number().int().positive(), asDelegate: z.boolean().default(false) }).parse(req.body);
  await stepOf(req.user!.tenantId, idParam(req.params.id), body.requestStepId);
  await reassignStep(req.user!.tenantId, actorFrom(req), body.requestStepId, body.newUserId, body.asDelegate);
  res.status(204).end();
});

adminRequestListRouter.post('/:id/remind', async (req, res) => {
  const { tenantId } = req.user!;
  const [active] = await tenantQuery<{ RequestStepId: number }>(
    tenantId,
    `SELECT RequestStepId FROM RequestSteps WHERE TenantId = @TenantId AND RequestId = @R AND Status = 'Active'`,
    { R: idParam(req.params.id) },
  );
  if (!active) throw new AppError(409, 'step_not_active', 'This request has no step awaiting a decision (if it was sent back, it is waiting on the submitter)');
  await remindStep(tenantId, actorFrom(req), active.RequestStepId, 'manual');
  res.status(204).end();
});

// ---------------------------------------------------------------------------------------
export const auditRouter = Router();

const auditQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  action: z.string().trim().max(60).optional(),
  userId: optionalId,
  requestId: optionalId,
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

function auditWhere(f: z.infer<typeof auditQuery>): { where: string; params: Params } {
  const where = ['a.TenantId = @TenantId'];
  const params: Params = {};
  if (f.from) (where.push('a.OccurredAt >= @From'), (params.From = f.from));
  if (f.to) (where.push('a.OccurredAt < DATEADD(DAY, 1, CAST(@To AS DATE))'), (params.To = f.to));
  if (f.action) (where.push(`a.Action LIKE @Action ESCAPE '\\'`), (params.Action = likeEscape(f.action)));
  if (f.userId) (where.push('a.UserId = @UserId'), (params.UserId = f.userId));
  if (f.requestId) (where.push('a.RequestId = @RequestId'), (params.RequestId = f.requestId));
  return { where: where.join(' AND '), params };
}
const AUDIT_SELECT = `SELECT a.AuditId, a.OccurredAt, a.Action, a.EntityType, a.EntityId, a.RequestId, r.RequestNumber, a.FromState, a.ToState,
                             a.UserId, u.DisplayName, u.Email, a.IpAddress, a.UserAgent, a.DetailJson
                        FROM AuditLog a
                        LEFT JOIN Users u ON u.TenantId = a.TenantId AND u.UserId = a.UserId
                        LEFT JOIN Requests r ON r.TenantId = a.TenantId AND r.RequestId = a.RequestId`;

auditRouter.get('/', async (req, res) => {
  const f = auditQuery.parse(req.query);
  const { where, params } = auditWhere(f);
  const rows = await tenantQuery<Record<string, any>>(
    req.user!.tenantId,
    `${AUDIT_SELECT.replace('SELECT', 'SELECT COUNT(*) OVER () AS Total,')} WHERE ${where}
      ORDER BY a.AuditId DESC OFFSET @Offset ROWS FETCH NEXT @Size ROWS ONLY`,
    { ...params, Offset: (f.page - 1) * f.pageSize, Size: f.pageSize },
  );
  res.json({
    total: rows[0]?.Total ?? 0,
    page: f.page,
    pageSize: f.pageSize,
    entries: rows.map((a) => ({
      auditId: a.AuditId, occurredAt: a.OccurredAt, action: a.Action, entityType: a.EntityType, entityId: a.EntityId, requestId: a.RequestId,
      requestNumber: a.RequestNumber, fromState: a.FromState, toState: a.ToState, user: a.DisplayName ?? 'System', ip: a.IpAddress,
      detail: a.DetailJson ? JSON.parse(a.DetailJson) : null,
    })),
  });
});

// Spreadsheet apps execute cells starting with = + - @ ; neutralise them, then apply normal CSV quoting.
const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Streams the (filtered) audit log as CSV in keyset-paged chunks, so exports of any size use constant memory. */
auditRouter.get('/export.csv', async (req, res) => {
  const f = auditQuery.parse(req.query);
  const { tenantId } = req.user!;
  const { where, params } = auditWhere(f);
  await audit(tenantId, actorFrom(req), { action: 'audit.exported', entityType: 'AuditLog', detail: { filters: { ...f, page: undefined, pageSize: undefined } } });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.write('﻿AuditId,OccurredAtUtc,Action,EntityType,EntityId,RequestNumber,FromState,ToState,UserId,UserName,UserEmail,IpAddress,UserAgent,Detail\r\n');
  let after = 0;
  for (;;) {
    const rows = await tenantQuery<Record<string, any>>(
      tenantId,
      `${AUDIT_SELECT.replace('SELECT', 'SELECT TOP 2000')} WHERE ${where} AND a.AuditId > @After ORDER BY a.AuditId`,
      { ...params, After: after },
    );
    if (!rows.length) break;
    res.write(
      rows.map((a) => [a.AuditId, a.OccurredAt, a.Action, a.EntityType, a.EntityId, a.RequestNumber, a.FromState, a.ToState, a.UserId, a.DisplayName ?? 'System', a.Email, a.IpAddress, a.UserAgent, a.DetailJson].map(csvCell).join(',')).join('\r\n') + '\r\n',
    );
    after = rows[rows.length - 1].AuditId;
  }
  res.end();
});

// ---------------------------------------------------------------------------------------
export const adminNotificationsRouter = Router();

adminNotificationsRouter.get('/', async (req, res) => {
  const status = z.enum(['Queued', 'Sent', 'Failed']).default('Failed').parse(req.query.status);
  const rows = await tenantQuery<Record<string, any>>(
    req.user!.tenantId,
    `SELECT TOP 200 n.NotificationId, n.Type, n.RecipientEmail, n.Subject, n.Status, n.Attempts, n.CreatedAt, n.LastError, n.RequestId
       FROM Notifications n WHERE n.TenantId = @TenantId AND n.Status = @Status ORDER BY n.NotificationId DESC`,
    { Status: status },
  );
  res.json({ notifications: rows.map((m) => ({ notificationId: m.NotificationId, type: m.Type, to: m.RecipientEmail, subject: m.Subject, status: m.Status, attempts: m.Attempts, createdAt: m.CreatedAt, lastError: m.LastError, requestId: m.RequestId })) });
});

adminNotificationsRouter.post('/:id/resend', async (req, res) => {
  const id = idParam(req.params.id);
  const rows = await tenantQuery(
    req.user!.tenantId,
    `UPDATE Notifications SET Status = 'Queued', Attempts = 0, NextAttemptAt = NULL, LastError = NULL
     OUTPUT inserted.NotificationId WHERE TenantId = @TenantId AND NotificationId = @Id AND Status = 'Failed'`,
    { Id: id },
  );
  if (!rows.length) throw new AppError(409, 'not_failed', 'Only failed notifications can be resent');
  await audit(req.user!.tenantId, actorFrom(req), { action: 'notification.requeued', entityType: 'Notification', entityId: id });
  res.status(204).end();
});
