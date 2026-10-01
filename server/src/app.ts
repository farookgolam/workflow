import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { adminFormsRouter, adminRequestsRouter } from './admin/forms.routes';
import { adminNotificationsRouter, adminRequestListRouter, auditRouter, dashboardRouter } from './admin/portal.routes';
import { adminSettingsRouter } from './admin/settings.routes';
import { adminUsersRouter } from './admin/users.routes';
import { adminExportRouter } from './archive/export.routes';
import { adminArchiveRouter, approverPdfRouter, myPdfRouter } from './archive/routes';
import { adminAttachmentsRouter, approverAttachmentsRouter } from './attachments/routes';
import { approvalsRouter, formsRouter, myRouter } from './workflow/routes';
import { cleanIp } from './audit/audit';
import { requireAuth, requireRole } from './auth/middleware';
import { authRouter } from './auth/routes';
import { config } from './config';
import { unscopedQuery } from './db/query';
import { errorHandler, notFound } from './http/errors';
import { platformAdminsRouter } from './platform/admins.routes';
import { platformAuthRouter } from './platform/auth.routes';
import { requirePlatformAdmin } from './platform/identity';
import { platformStatsRouter, platformTenantsRouter } from './platform/tenants.routes';
import { adminLookupsRouter } from './lookups/routes';
import { adminReportsRouter } from './reports/routes';
import { siteRouter } from './site.routes';
import { globalHelpRouter, helpRouter } from './help/routes';
import { aboutRouter, globalAboutRouter } from './about/routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  // Normalise the client address once, before anything reads it (rate limiters, audit log, refresh-token records).
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: cleanIp(req.ip) ?? undefined, configurable: true });
    next();
  });
  app.use(helmet());
  // a form definition can carry a few pictures (each up to IMAGE_MAX_CHARS as a data: URL); an HTML import keeps the 1mb cap
  const formJson = express.json({ limit: '6mb' });
  app.use('/api/v1/admin/forms', (req, res, next) => (req.path.startsWith('/import-html') ? next() : formJson(req, res, next)));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  const api = express.Router();
  // Nothing the API returns may be cached by a proxy in front of it: almost every response belongs to
  // one customer and one signed-in person, and a shared cache could hand it to the next request.
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // coarse flood protection for the whole API; /auth has its own, stricter limiter
  api.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false, skip: () => config.isTest }));
  api.get('/health', async (_req, res) => {
    try {
      await unscopedQuery('SELECT 1 AS ok');
      res.json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'down' });
    }
  });
  // which customer this address is, and how it is branded - needed before anyone signs in
  api.use('/site', siteRouter);
  api.use('/auth', authRouter);
  // the PDF manuals: each route checks its own sign-in (a customer's, a global administrator's, or a short-lived link)
  api.use('/help', helpRouter);
  api.use('/about', aboutRouter); // name, version, last update, contact (each route checks its own sign-in)
  // The global management site: creating and managing customers. Its own identity, its own
  // JWT audience - a customer's token can never reach these routes, or the other way round.
  api.use('/global/auth', platformAuthRouter);
  api.use('/global/tenants', requirePlatformAdmin, platformTenantsRouter);
  api.use('/global/stats', requirePlatformAdmin, platformStatsRouter);
  api.use('/global/admins', requirePlatformAdmin, platformAdminsRouter);
  api.use('/global/help', globalHelpRouter);
  api.use('/global/about', globalAboutRouter);
  api.use('/admin', requireAuth, requireRole('Admin'));
  api.use('/admin/dashboard', dashboardRouter);
  api.use('/admin/audit', auditRouter);
  api.use('/admin/notifications', adminNotificationsRouter);
  api.use('/admin/lookups', adminLookupsRouter);
  api.use('/admin/reports', adminReportsRouter);
  api.use('/admin/settings', adminSettingsRouter);
  api.use('/admin/users', adminUsersRouter);
  api.use('/admin/forms', adminFormsRouter);
  api.use('/admin/requests', adminAttachmentsRouter);
  api.use('/admin/requests', adminRequestsRouter);
  api.use('/admin/requests', adminArchiveRouter);
  api.use('/admin/exports', adminExportRouter);
  api.use('/admin/requests', adminRequestListRouter);
  api.use('/forms', requireAuth, formsRouter);
  api.use('/my', requireAuth, myRouter, myPdfRouter);
  api.use('/approvals', requireAuth, approverPdfRouter, approverAttachmentsRouter, approvalsRouter);

  app.use('/api/v1', api);
  app.use('/api', notFound); // unknown API paths are JSON 404s, never the SPA shell

  // Optional single-process hosting: serve the built React app and let client-side routing handle deep links.
  if (config.clientDir && fs.existsSync(path.join(config.clientDir, 'index.html'))) {
    const clientDir = config.clientDir;
    app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
    app.get(/.*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  }
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
