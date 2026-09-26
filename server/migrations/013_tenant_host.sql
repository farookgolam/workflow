-- 013: each customer can be reached on its own host ("sub-site"), e.g. acme.approvals.example.com.
-- Host is optional: with APP_DOMAIN set, <slug>.<APP_DOMAIN> resolves without a row here, and a
-- deployment with a single customer keeps working with no host at all.
ALTER TABLE Tenants ADD Host NVARCHAR(253) NULL;
GO

CREATE UNIQUE INDEX UQ_Tenants_Host ON Tenants (Host) WHERE Host IS NOT NULL;
GO
