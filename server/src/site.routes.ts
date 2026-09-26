// What the sign-in page needs before anybody is signed in: which customer this address belongs to,
// and how it is branded. Public by design - the host is already public - and it says nothing about
// who has an account here.
import { Router } from 'express';
import { effectiveSettings } from './settings/service';
import { resolveTenant } from './tenant';

export const siteRouter = Router();

siteRouter.get('/', async (req, res) => {
  const tenant = await resolveTenant(req); // 404 at an address that belongs to no customer
  const { brand } = await effectiveSettings(tenant.tenantId);
  res.json({
    site: {
      slug: tenant.slug,
      name: brand.name ?? tenant.name,
      brandColor: brand.color,
      logoDataUrl: brand.logoDataUrl,
    },
  });
});
