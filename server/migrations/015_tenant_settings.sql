-- 015: per-customer settings. Everything here used to be one server-wide environment variable, which
-- only works while the application hosts a single organisation. NULL means "inherit the server default",
-- so an existing deployment behaves exactly as before until somebody changes something.
--
-- The Graph client secret is stored encrypted (AES-256-GCM, see src/settings/secretbox.ts) and is never
-- sent back over the API - it can only be replaced.
CREATE TABLE TenantSettings (
  TenantId INT NOT NULL CONSTRAINT PK_TenantSettings PRIMARY KEY REFERENCES Tenants (TenantId),

  -- branding, shown on the sign-in page, in the portal header and on the archived PDF
  BrandName NVARCHAR(200) NULL,
  BrandColor VARCHAR(7) NULL CONSTRAINT CK_TenantSettings_Colour CHECK (BrandColor IS NULL OR BrandColor LIKE '#[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]'),
  LogoDataUrl NVARCHAR(MAX) NULL,

  -- who may register, and whether first sign-in must prove the address by email
  AllowedEmailDomains NVARCHAR(1000) NULL,
  FirstLoginEmailVerification BIT NULL,

  -- what the customer's emails are sent as
  MailFromName NVARCHAR(200) NULL,
  MailFromEmail NVARCHAR(320) NULL,

  -- where the customer archives, and with whose credentials
  SharePointMode VARCHAR(10) NULL CONSTRAINT CK_TenantSettings_SpMode CHECK (SharePointMode IN ('graph','dryrun')),
  GraphTenantId NVARCHAR(100) NULL,
  GraphClientId NVARCHAR(100) NULL,
  GraphClientSecret VARBINARY(MAX) NULL,

  UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_TenantSettings_UpdatedAt DEFAULT SYSUTCDATETIME()
);
GO

-- Every existing customer starts with "inherit everything", so nothing changes until it is edited.
INSERT INTO TenantSettings (TenantId) SELECT TenantId FROM Tenants;
GO
