import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // a TCP port, or a named pipe when hosted by iisnode (\\.\pipe\...)
  PORT: z.string().default('4100'),
  // Optional: folder with the built React app (client/dist). When set, Node serves the UI too.
  CLIENT_DIR: z.string().optional(),
  APP_BASE_URL: z.string().url().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  DB_AUTH: z.enum(['windows', 'sql']).default('windows'),
  DB_SERVER: z.string().min(1).default('.\\SQLEXPRESS'),
  DB_NAME: z.string().regex(/^[A-Za-z0-9_]+$/, 'DB_NAME may only contain letters, digits and _'),
  DB_ODBC_DRIVER: z.string().default('ODBC Driver 17 for SQL Server'),
  DB_USER: z.string().optional(),
  DB_PASSWORD: z.string().optional(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TTL_MIN: z.coerce.number().int().positive().default(15),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(14),
  COOKIE_SECURE: bool,

  // Tenant addressing. With APP_DOMAIN set, each customer is reached at <slug>.<APP_DOMAIN> (or at its own
  // Tenants.Host). TENANT_SLUG stays as the single-customer fallback for deployments with no host routing.
  APP_DOMAIN: z.string().optional(),
  // Host of the global management site, if it is served from this API (never resolves to a customer).
  PLATFORM_HOST: z.string().optional(),
  TENANT_SLUG: z.string().optional(),
  // A removed customer's data is kept this many days (restorable) before it is deleted for good.
  TENANT_REMOVAL_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  // First-time setup (and setup after an admin reset) emails a one-time code to prove the address is theirs.
  // Turning this off lets anyone claim any email address that has no password key yet.
  FIRST_LOGIN_EMAIL_VERIFICATION: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // Comma-separated list, e.g. "example.com,example.co.uk". Empty = any address may self-register.
  ALLOWED_EMAIL_DOMAINS: z.string().optional(),

  // Leave SMTP_HOST empty to write emails to STORAGE_DIR/mail as .eml files instead of sending them.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(25),
  SMTP_SECURE: bool, // true = implicit TLS (465); false = plain/STARTTLS
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().default('Approvals <no-reply@localhost>'),
  STORAGE_DIR: z.string().default('./storage'),
  // the PDF manuals (docs/manuals/build-manuals.cjs); served to signed-in people only, by /api/v1/help
  MANUALS_DIR: z.string().default('../docs/manuals'),

});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}
const env = parsed.data;

if (env.NODE_ENV === 'production') {
  if (!env.COOKIE_SECURE) console.warn('WARNING: COOKIE_SECURE=false in production - the refresh cookie will be sent over plain HTTP.');
  if (!env.APP_BASE_URL.startsWith('https://')) console.warn('WARNING: APP_BASE_URL is not https - links in emails will be insecure.');
  if (!env.FIRST_LOGIN_EMAIL_VERIFICATION) console.warn('WARNING: FIRST_LOGIN_EMAIL_VERIFICATION=false - anyone can claim an email address that has no password key yet.');
  if (!env.SMTP_HOST) console.warn('WARNING: SMTP_HOST is not set - emails are written to disk, not sent.');
}

export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: /^\d+$/.test(env.PORT) ? Number(env.PORT) : env.PORT,
  clientDir: env.CLIENT_DIR ? path.resolve(env.CLIENT_DIR) : null,
  tenantSlug: env.TENANT_SLUG || null,
  tenantRemovalDays: env.TENANT_REMOVAL_DAYS,
  signup: {
    verifyEmail: env.FIRST_LOGIN_EMAIL_VERIFICATION,
    allowedDomains: (env.ALLOWED_EMAIL_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean),
    codeTtlMinutes: 10,
    codeMaxAttempts: 5,
    codeResendSeconds: 60,
  },
  appBaseUrl: env.APP_BASE_URL.replace(/\/$/, ''),
  // scheme used to build per-customer URLs (https in any real deployment)
  appProtocol: new URL(env.APP_BASE_URL).protocol.replace(/:$/, ''),
  // ...and the non-default port they share with APP_BASE_URL ('' for 80/443), since Tenants.Host carries no port
  appPort: new URL(env.APP_BASE_URL).port,
  appDomain: (env.APP_DOMAIN ?? '').trim().toLowerCase().replace(/^\./, '') || null,
  platformHost: (env.PLATFORM_HOST ?? '').trim().toLowerCase() || null,
  trustProxy: env.TRUST_PROXY,
  db: {
    auth: env.DB_AUTH,
    server: env.DB_SERVER,
    name: env.DB_NAME,
    odbcDriver: env.DB_ODBC_DRIVER,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
  },
  auth: {
    jwtSecret: env.JWT_SECRET,
    accessTtlMin: env.ACCESS_TTL_MIN,
    refreshTtlDays: env.REFRESH_TTL_DAYS,
    cookieSecure: env.COOKIE_SECURE,
    maxFailedLogins: 5,
    lockMinutes: 15,
    approvalTokenTtlDays: 14,
  },
  mail: {
    host: env.SMTP_HOST || null,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    user: env.SMTP_USER || null,
    password: env.SMTP_PASSWORD || null,
    from: env.MAIL_FROM,
    maxAttempts: 6,
    backoffMinutes: [1, 5, 15, 60, 180],
  },
  storageDir: path.resolve(env.STORAGE_DIR),
  manualsDir: path.resolve(env.MANUALS_DIR),
};
