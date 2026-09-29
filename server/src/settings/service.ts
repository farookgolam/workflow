// Per-customer settings, with the server-wide environment values as the fallback.
//
// Reads go through effectiveSettings(), which is cached per customer; anything that writes calls
// forgetSettings(). A NULL column means "inherit", so a customer that has never been edited behaves
// exactly like the single-organisation deployment did.
import { tenantQuery } from '../db/query';
import { config } from '../config';

export interface TenantSettingsRow {
  BrandName: string | null;
  BrandColor: string | null;
  LogoDataUrl: string | null;
  AllowedEmailDomains: string | null;
  FirstLoginEmailVerification: boolean | null;
  MailFromName: string | null;
  MailFromEmail: string | null;
  EmailShowDetails: boolean | null;
}

export interface EffectiveSettings {
  brand: { name: string | null; color: string | null; logoDataUrl: string | null };
  signup: { allowedDomains: string[]; verifyEmail: boolean };
  /** showDetails: approval emails list the submitted values (on unless the customer turned it off). */
  mail: { from: string; showDetails: boolean };
}

const cache = new Map<number, EffectiveSettings>();
export const forgetSettings = (tenantId?: number) => (tenantId === undefined ? cache.clear() : cache.delete(tenantId));

const domainList = (csv: string | null): string[] =>
  (csv ?? '').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);

const mailFrom = (row: TenantSettingsRow): string => {
  if (!row.MailFromEmail) return config.mail.from;
  return row.MailFromName ? `${row.MailFromName} <${row.MailFromEmail}>` : row.MailFromEmail;
};

export async function rawSettings(tenantId: number): Promise<TenantSettingsRow> {
  const [row] = await tenantQuery<TenantSettingsRow>(
    tenantId,
    `SELECT BrandName, BrandColor, LogoDataUrl, AllowedEmailDomains, FirstLoginEmailVerification,
            MailFromName, MailFromEmail, EmailShowDetails
       FROM TenantSettings WHERE TenantId = @TenantId`,
  );
  return (
    row ?? {
      BrandName: null,
      BrandColor: null,
      LogoDataUrl: null,
      AllowedEmailDomains: null,
      FirstLoginEmailVerification: null,
      MailFromName: null,
      MailFromEmail: null,
      EmailShowDetails: null,
    }
  );
}

/** What this customer actually runs with: its own values where set, the server defaults elsewhere. */
export async function effectiveSettings(tenantId: number): Promise<EffectiveSettings> {
  const hit = cache.get(tenantId);
  if (hit) return hit;
  const row = await rawSettings(tenantId);
  const settings: EffectiveSettings = {
    brand: { name: row.BrandName, color: row.BrandColor, logoDataUrl: row.LogoDataUrl },
    signup: {
      allowedDomains: row.AllowedEmailDomains === null ? config.signup.allowedDomains : domainList(row.AllowedEmailDomains),
      verifyEmail: row.FirstLoginEmailVerification === null ? config.signup.verifyEmail : row.FirstLoginEmailVerification,
    },
    mail: { from: mailFrom(row), showDetails: row.EmailShowDetails !== false },
  };
  cache.set(tenantId, settings);
  return settings;
}

export interface SettingsPatch {
  brandName?: string | null;
  brandColor?: string | null;
  logoDataUrl?: string | null;
  allowedEmailDomains?: string | null;
  firstLoginEmailVerification?: boolean | null;
  mailFromName?: string | null;
  mailFromEmail?: string | null;
  emailShowDetails?: boolean | null;
}

const COLUMNS: Record<keyof SettingsPatch, string> = {
  brandName: 'BrandName',
  brandColor: 'BrandColor',
  logoDataUrl: 'LogoDataUrl',
  allowedEmailDomains: 'AllowedEmailDomains',
  firstLoginEmailVerification: 'FirstLoginEmailVerification',
  mailFromName: 'MailFromName',
  mailFromEmail: 'MailFromEmail',
  emailShowDetails: 'EmailShowDetails',
};

/** Applies only the keys that are present. Returns the names that changed, for the audit entry. */
export async function updateSettings(tenantId: number, patch: SettingsPatch): Promise<string[]> {
  const sets: string[] = [];
  const params: Record<string, string | number | boolean | null> = {};
  const changed: string[] = [];

  for (const [key, column] of Object.entries(COLUMNS) as [keyof typeof COLUMNS, string][]) {
    if (!(key in patch)) continue;
    const value = patch[key] as string | boolean | null | undefined;
    sets.push(`${column} = @${column}`);
    params[column] = value === undefined || value === '' ? null : value;
    changed.push(key);
  }
  if (!sets.length) return [];

  // A customer may not have a settings row yet (it is created lazily), so make sure of it first -
  // an INSERT that only carried the key would silently drop the values being set.
  await tenantQuery(
    tenantId,
    `IF NOT EXISTS (SELECT 1 FROM TenantSettings WHERE TenantId = @TenantId)
       INSERT INTO TenantSettings (TenantId) VALUES (@TenantId);
     UPDATE TenantSettings SET ${sets.join(', ')}, UpdatedAt = SYSUTCDATETIME() WHERE TenantId = @TenantId;`,
    params,
  );
  forgetSettings(tenantId);
  return changed;
}

/** What the settings screens show: this customer's own values, and what is in force where they inherit. */
export async function settingsForApi(tenantId: number) {
  const row = await rawSettings(tenantId);
  const effective = await effectiveSettings(tenantId);
  return {
    brandName: row.BrandName,
    brandColor: row.BrandColor,
    logoDataUrl: row.LogoDataUrl,
    allowedEmailDomains: row.AllowedEmailDomains,
    firstLoginEmailVerification: row.FirstLoginEmailVerification,
    mailFromName: row.MailFromName,
    mailFromEmail: row.MailFromEmail,
    emailShowDetails: row.EmailShowDetails,
    effective: {
      allowedDomains: effective.signup.allowedDomains,
      verifyEmail: effective.signup.verifyEmail,
      mailFrom: effective.mail.from,
    },
  };
}
