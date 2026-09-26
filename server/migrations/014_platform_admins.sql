-- 014: global ("platform") administrators - the people who create and manage customers.
--
-- Deliberately OUTSIDE the tenant world: no TenantId, and NOT rows in Users. That way a customer
-- administrator's user management can never see, deactivate or reset a global administrator, and no
-- tenant-scoped query can ever return one. Their sessions use their own cookie and their own JWT
-- audience, so a platform token is rejected by the customer API and vice versa.
CREATE TABLE PlatformAdmins (
  PlatformAdminId INT IDENTITY PRIMARY KEY,
  Email NVARCHAR(320) NOT NULL CONSTRAINT UQ_PlatformAdmins_Email UNIQUE,
  PasswordHash NVARCHAR(255) NOT NULL,
  DisplayName NVARCHAR(200) NOT NULL,
  IsActive BIT NOT NULL CONSTRAINT DF_PlatformAdmins_IsActive DEFAULT 1,
  FailedLoginCount INT NOT NULL CONSTRAINT DF_PlatformAdmins_Failed DEFAULT 0,
  LockedUntil DATETIME2(3) NULL,
  PasswordSetAt DATETIME2(3) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_PlatformAdmins_CreatedAt DEFAULT SYSUTCDATETIME()
);
GO

CREATE TABLE PlatformRefreshTokens (
  TokenId BIGINT IDENTITY PRIMARY KEY,
  PlatformAdminId INT NOT NULL REFERENCES PlatformAdmins (PlatformAdminId),
  TokenHash VARBINARY(32) NOT NULL CONSTRAINT UQ_PlatformRefreshTokens_Hash UNIQUE,
  ExpiresAt DATETIME2(3) NOT NULL,
  RevokedAt DATETIME2(3) NULL,
  CreatedIp VARCHAR(45) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_PlatformRefreshTokens_CreatedAt DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_PlatformRefreshTokens_Admin ON PlatformRefreshTokens (PlatformAdminId);
GO

-- Everything a global administrator does, including which customer it touched. Append-only, like AuditLog.
-- Actions inside a customer are ALSO written to that customer's own AuditLog, so nothing a global
-- administrator does is invisible from inside the customer.
CREATE TABLE PlatformAuditLog (
  PlatformAuditId BIGINT IDENTITY PRIMARY KEY,
  PlatformAdminId INT NULL REFERENCES PlatformAdmins (PlatformAdminId),
  TenantId INT NULL REFERENCES Tenants (TenantId),
  IpAddress VARCHAR(45) NULL,
  UserAgent NVARCHAR(400) NULL,
  Action VARCHAR(60) NOT NULL,
  EntityType VARCHAR(40) NOT NULL,
  EntityId INT NULL,
  DetailJson NVARCHAR(MAX) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_PlatformAuditLog_CreatedAt DEFAULT SYSUTCDATETIME()
);
GO
CREATE INDEX IX_PlatformAuditLog_Created ON PlatformAuditLog (CreatedAt DESC);
GO

CREATE TRIGGER TR_PlatformAuditLog_Immutable ON PlatformAuditLog INSTEAD OF UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  THROW 51000, 'PlatformAuditLog is append-only.', 1;
END
GO
