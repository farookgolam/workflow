// The PDF manuals, for signed-in people only. The app keeps its sign-in token in memory and sends it as a header,
// which a new browser tab showing a PDF cannot do. So opening a manual takes two steps:
//   1. POST /help/link (signed in; /global/help/link for global administrators) -> a link to the one manual this person may read, valid for a few minutes
//   2. GET  /help/manuals/<file>?t=... -> the PDF, shown in the browser's own viewer
// Administrators may read the Administrator Manual, everyone the User Manual and the workflow sheet, global
// administrators the Global Administrator Manual. The link names its file, so it cannot be reused for another manual.
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware';
import { config } from '../config';
import { AppError } from '../http/errors';
import { requirePlatformAdmin } from '../platform/identity';

export const MANUALS = {
  user: 'FileBank-WorkFlow-User-Manual.pdf',
  admin: 'FileBank-WorkFlow-Administrator-Manual.pdf',
  global: 'FileBank-WorkFlow-Global-Administrator-Manual.pdf',
  // the request workflow on two pages: diagram and step by step (docs/manuals/build-process-flow.cjs)
  workflow: 'FileBank-WorkFlow-Process-Flow.pdf',
} as const;
type Manual = keyof typeof MANUALS;

const AUDIENCE = 'manual';
const LINK_MINUTES = 5;

function link(manual: Manual): { url: string } {
  const t = jwt.sign({ f: MANUALS[manual] }, config.auth.jwtSecret, { algorithm: 'HS256', issuer: 'approvalflow', audience: AUDIENCE, expiresIn: LINK_MINUTES * 60 });
  return { url: `/api/v1/help/manuals/${MANUALS[manual]}?t=${encodeURIComponent(t)}` };
}

export const helpRouter = Router();

/** A customer's user: the User Manual and the workflow sheet, and - for administrators - the Administrator Manual. */
helpRouter.post('/link', requireAuth, (req, res) => {
  const { manual } = z.object({ manual: z.enum(['user', 'admin', 'workflow']) }).parse(req.body);
  if (manual === 'admin' && !req.user!.roles.includes('Admin')) throw new AppError(403, 'forbidden', 'The Administrator Manual is for administrators');
  res.json(link(manual));
});

/** A global administrator (the console calls /api/v1/global/help/link): the Global Administrator Manual. */
export const globalHelpRouter = Router();
globalHelpRouter.post('/link', requirePlatformAdmin, (_req, res) => {
  res.json(link('global'));
});

helpRouter.get('/manuals/:file', (req, res) => {
  const file = req.params.file;
  let allowed = false;
  try {
    const p = jwt.verify(String(req.query.t ?? ''), config.auth.jwtSecret, { algorithms: ['HS256'], issuer: 'approvalflow', audience: AUDIENCE }) as jwt.JwtPayload;
    allowed = p.f === file;
  } catch { /* missing, expired or forged */ }
  if (!allowed) throw new AppError(401, 'unauthenticated', 'This link has expired. Open the manual again from Help in the app.');
  const full = path.join(config.manualsDir, file);
  if (!(Object.values(MANUALS) as string[]).includes(file) || !fs.existsSync(full)) throw new AppError(404, 'not_found', 'That manual is not available');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${file}"`);
  // the API's usual policy (object-src 'none') would stop the browser's PDF viewer
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  fs.createReadStream(full).pipe(res);
});
