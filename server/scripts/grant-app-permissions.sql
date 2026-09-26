-- Least-privilege database access for the account the Windows service runs as.
-- Run once per environment as a sysadmin, AFTER `npm run migrate` has created the schema.
-- Replace the two placeholders below:
--   ApprovalFlow              -> your database name (DB_NAME)
--   DOMAIN\svc-approvalflow   -> the identity to grant (see below)
--
-- Which identity: prefer the service's own SID, NT SERVICE\approvalflowapi.exe, which the installer enables
-- (windows-service.cjs). It is in the process token whatever account the service logs on as, so the grant
-- survives a change of Log On account and gives nothing to anything else running as that account. Use the
-- Log On account itself (a domain account, gMSA, or a SQL login when DB_AUTH=sql) only if you prefer.
--
-- Migrations need DDL rights, so run `npm run migrate` as an administrator / deployment account,
-- not as this runtime account.

USE [master];
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'DOMAIN\svc-approvalflow')
  CREATE LOGIN [DOMAIN\svc-approvalflow] FROM WINDOWS;
GO

USE [ApprovalFlow];
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'DOMAIN\svc-approvalflow')
  CREATE USER [DOMAIN\svc-approvalflow] FOR LOGIN [DOMAIN\svc-approvalflow];

ALTER ROLE db_datareader ADD MEMBER [DOMAIN\svc-approvalflow];
ALTER ROLE db_datawriter ADD MEMBER [DOMAIN\svc-approvalflow];

-- Belt and braces on top of the immutability triggers: the app account cannot rewrite history at all.
DENY UPDATE, DELETE ON dbo.AuditLog         TO [DOMAIN\svc-approvalflow];
DENY UPDATE, DELETE ON dbo.PlatformAuditLog TO [DOMAIN\svc-approvalflow];
DENY UPDATE, DELETE ON dbo.StepResponses TO [DOMAIN\svc-approvalflow];
DENY DELETE ON dbo.Requests              TO [DOMAIN\svc-approvalflow];
DENY DELETE ON dbo.RequestSteps          TO [DOMAIN\svc-approvalflow];
DENY DELETE ON dbo.RequestData           TO [DOMAIN\svc-approvalflow];
DENY UPDATE, DELETE ON dbo.SchemaMigrations TO [DOMAIN\svc-approvalflow];
DENY UPDATE, DELETE ON dbo.RequestDocuments TO [DOMAIN\svc-approvalflow]; -- archived PDFs (migration 019)

-- The one way to remove a customer's history: a global administrator removing a suspended customer
-- (migration 016). The procedure checks that itself; the DENYs above still apply everywhere else.
GRANT EXECUTE ON dbo.PurgeTenant TO [DOMAIN\svc-approvalflow];
GO
