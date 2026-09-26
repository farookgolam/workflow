-- 002: self-service accounts. Users create their own 6-digit password key at first sign-in;
-- an administrator can only RESET a key (which sends the user back through first-time setup).

-- NULL = the user has no key yet (never signed in, or an administrator reset it)
ALTER TABLE Users ADD PasswordSetAt DATETIME2(3) NULL;
GO

UPDATE Users SET PasswordSetAt = CreatedAt;   -- everyone who already exists has a password
GO

-- One-time codes that prove ownership of an email address during first-time setup.
-- Only a keyed hash of the code is stored.
CREATE TABLE EmailVerifications (
  VerificationId BIGINT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL REFERENCES Tenants (TenantId),
  Email NVARCHAR(320) NOT NULL,
  CodeHash VARBINARY(32) NOT NULL,
  ExpiresAt DATETIME2(3) NOT NULL,
  Attempts INT NOT NULL CONSTRAINT DF_EmailVerifications_Attempts DEFAULT 0,
  ConsumedAt DATETIME2(3) NULL,
  CreatedIp VARCHAR(45) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_EmailVerifications_CreatedAt DEFAULT SYSUTCDATETIME()
);
CREATE INDEX IX_EmailVerifications_Email ON EmailVerifications (TenantId, Email, VerificationId DESC);
GO
