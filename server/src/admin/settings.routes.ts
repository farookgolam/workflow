// A customer administrator's own settings page: /api/v1/admin/settings
// The same shape is editable by a global administrator at /api/v1/global/tenants/:id/settings.
import { Router } from 'express';
import { z } from 'zod';
import { actorFrom, audit } from '../audit/audit';
import { settingsForApi, updateSettings } from '../settings/service';

export const settingsPatchBody = z
  .object({
    brandName: z.string().trim().max(200).nullable(),
    brandColor: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #2563eb').nullable(),
    // a small inline logo; anything bigger belongs on a CDN, and the body limit is 1 MB anyway
    logoDataUrl: z.string().trim().startsWith('data:image/', 'That is not an image').max(400_000).nullable(),
    allowedEmailDomains: z.string().trim().max(1000).nullable(),
    firstLoginEmailVerification: z.boolean().nullable(),
    mailFromName: z.string().trim().max(200).nullable(),
    mailFromEmail: z.string().trim().email().max(320).nullable(),
    emailShowDetails: z.boolean().nullable(),
  })
  .partial();

export const adminSettingsRouter = Router();

adminSettingsRouter.get('/', async (req, res) => {
  res.json({ settings: await settingsForApi(req.user!.tenantId) });
});

adminSettingsRouter.patch('/', async (req, res) => {
  const patch = settingsPatchBody.parse(req.body);
  const tenantId = req.user!.tenantId;
  const changed = await updateSettings(tenantId, patch);
  if (changed.length) {
    await audit(tenantId, actorFrom(req), {
      action: 'settings.updated',
      entityType: 'Tenant',
      entityId: tenantId,
      detail: { changed },
    });
  }
  res.json({ settings: await settingsForApi(tenantId), changed });
});
