-- 001_init: full schema. Batches are separated by GO (handled by src/db/migrate.ts).
-- Conventions: every table has TenantId; child tables use composite FKs (TenantId, ParentId)
-- so a row can never point at another tenant's parent. All timestamps are UTC.

CREATE TABLE Tenants (
  TenantId INT IDENTITY PRIMARY KEY,
  Name NVARCHAR(200) NOT NULL,
  Slug NVARCHAR(63) NOT NULL CONSTRAINT UQ_Tenants_Slug UNIQUE,
  AdminNotifyEmail NVARCHAR(320) NULL,
  IsActive BIT NOT NULL CONSTRAINT DF_Tenants_IsActive DEFAULT 1,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Tenants_CreatedAt DEFAULT SYSUTCDATETIME()
);

CREATE TABLE Users (
  UserId INT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL REFERENCES Tenants (TenantId),
  Email NVARCHAR(320) NOT NULL,
  PasswordHash NVARCHAR(255) NOT NULL,
  DisplayName NVARCHAR(200) NOT NULL,
  IsActive BIT NOT NULL CONSTRAINT DF_Users_IsActive DEFAULT 1,
  FailedLoginCount INT NOT NULL CONSTRAINT DF_Users_Failed DEFAULT 0,
  LockedUntil DATETIME2(3) NULL,
  PasswordResetTokenHash VARBINARY(32) NULL,
  PasswordResetExpiresAt DATETIME2(3) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Users_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_Users_Tenant_Email UNIQUE (TenantId, Email),
  CONSTRAINT UQ_Users_Tenant_Id UNIQUE (TenantId, UserId)
);
CREATE INDEX IX_Users_ResetToken ON Users (PasswordResetTokenHash) WHERE PasswordResetTokenHash IS NOT NULL;

CREATE TABLE UserRoles (
  TenantId INT NOT NULL,
  UserId INT NOT NULL,
  Role VARCHAR(20) NOT NULL CONSTRAINT CK_UserRoles_Role CHECK (Role IN ('Admin','Approver','Submitter')),
  CONSTRAINT PK_UserRoles PRIMARY KEY (TenantId, UserId, Role),
  CONSTRAINT FK_UserRoles_User FOREIGN KEY (TenantId, UserId) REFERENCES Users (TenantId, UserId)
);

CREATE TABLE RefreshTokens (
  TokenId BIGINT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  UserId INT NOT NULL,
  TokenHash VARBINARY(32) NOT NULL CONSTRAINT UQ_RefreshTokens_Hash UNIQUE,
  ExpiresAt DATETIME2(3) NOT NULL,
  RevokedAt DATETIME2(3) NULL,
  CreatedIp VARCHAR(45) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_RefreshTokens_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_RefreshTokens_User FOREIGN KEY (TenantId, UserId) REFERENCES Users (TenantId, UserId)
);
CREATE INDEX IX_RefreshTokens_User ON RefreshTokens (TenantId, UserId);

CREATE TABLE Forms (
  FormId INT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL REFERENCES Tenants (TenantId),
  Name NVARCHAR(200) NOT NULL,
  Slug NVARCHAR(100) NOT NULL,
  Description NVARCHAR(1000) NULL,
  IsActive BIT NOT NULL CONSTRAINT DF_Forms_IsActive DEFAULT 1,
  SubmittersSeeComments BIT NOT NULL CONSTRAINT DF_Forms_SeeComments DEFAULT 0,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Forms_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_Forms_Tenant_Slug UNIQUE (TenantId, Slug),
  CONSTRAINT UQ_Forms_Tenant_Id UNIQUE (TenantId, FormId)
);

CREATE TABLE FormFields (
  FieldId INT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  FormId INT NOT NULL,
  FieldKey VARCHAR(100) NOT NULL,
  Label NVARCHAR(200) NOT NULL,
  FieldType VARCHAR(20) NOT NULL CONSTRAINT CK_FormFields_Type
    CHECK (FieldType IN ('text','textarea','number','currency','date','select','checkbox','email')),
  IsRequired BIT NOT NULL CONSTRAINT DF_FormFields_Req DEFAULT 0,
  OptionsJson NVARCHAR(MAX) NULL,
  ValidationJson NVARCHAR(MAX) NULL,
  SortOrder INT NOT NULL,
  IsActive BIT NOT NULL CONSTRAINT DF_FormFields_IsActive DEFAULT 1,
  CONSTRAINT UQ_FormFields_Key UNIQUE (TenantId, FormId, FieldKey),
  CONSTRAINT UQ_FormFields_Tenant_Id UNIQUE (TenantId, FieldId),
  CONSTRAINT FK_FormFields_Form FOREIGN KEY (TenantId, FormId) REFERENCES Forms (TenantId, FormId)
);

CREATE TABLE ApprovalChains (
  ChainId INT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  FormId INT NOT NULL,
  Version INT NOT NULL,
  IsCurrent BIT NOT NULL CONSTRAINT DF_Chains_IsCurrent DEFAULT 0,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Chains_CreatedAt DEFAULT SYSUTCDATETIME(),
  CreatedBy INT NOT NULL,
  CONSTRAINT UQ_Chains_Version UNIQUE (TenantId, FormId, Version),
  CONSTRAINT UQ_Chains_Tenant_Id UNIQUE (TenantId, ChainId),
  CONSTRAINT FK_Chains_Form FOREIGN KEY (TenantId, FormId) REFERENCES Forms (TenantId, FormId),
  CONSTRAINT FK_Chains_CreatedBy FOREIGN KEY (TenantId, CreatedBy) REFERENCES Users (TenantId, UserId)
);
CREATE UNIQUE INDEX UX_Chains_OneCurrent ON ApprovalChains (TenantId, FormId) WHERE IsCurrent = 1;

CREATE TABLE ApprovalSteps (
  StepId INT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  ChainId INT NOT NULL,
  StepOrder INT NOT NULL,
  Name NVARCHAR(200) NOT NULL,
  ApproverUserId INT NOT NULL,
  ReminderAfterDays INT NULL,
  ReminderRepeatDays INT NULL,
  EscalateAfterDays INT NULL,
  EscalateToUserId INT NULL,
  CONSTRAINT UQ_Steps_Order UNIQUE (TenantId, ChainId, StepOrder),
  CONSTRAINT UQ_Steps_Tenant_Id UNIQUE (TenantId, StepId),
  CONSTRAINT CK_Steps_Order CHECK (StepOrder >= 1),
  CONSTRAINT FK_Steps_Chain FOREIGN KEY (TenantId, ChainId) REFERENCES ApprovalChains (TenantId, ChainId),
  CONSTRAINT FK_Steps_Approver FOREIGN KEY (TenantId, ApproverUserId) REFERENCES Users (TenantId, UserId),
  CONSTRAINT FK_Steps_EscalateTo FOREIGN KEY (TenantId, EscalateToUserId) REFERENCES Users (TenantId, UserId)
);

CREATE TABLE StepFields (
  StepFieldId INT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  StepId INT NOT NULL,
  FieldKey VARCHAR(100) NOT NULL,
  Label NVARCHAR(200) NOT NULL,
  FieldType VARCHAR(20) NOT NULL CONSTRAINT CK_StepFields_Type
    CHECK (FieldType IN ('text','textarea','number','currency','date','select','checkbox','email','signature')),
  IsRequired BIT NOT NULL CONSTRAINT DF_StepFields_Req DEFAULT 0,
  OptionsJson NVARCHAR(MAX) NULL,
  ValidationJson NVARCHAR(MAX) NULL,
  SortOrder INT NOT NULL,
  CONSTRAINT UQ_StepFields_Key UNIQUE (TenantId, StepId, FieldKey),
  CONSTRAINT UQ_StepFields_Tenant_Id UNIQUE (TenantId, StepFieldId),
  CONSTRAINT FK_StepFields_Step FOREIGN KEY (TenantId, StepId) REFERENCES ApprovalSteps (TenantId, StepId)
);

CREATE TABLE Requests (
  RequestId INT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  FormId INT NOT NULL,
  ChainId INT NOT NULL,
  RequestNumber VARCHAR(30) NOT NULL,
  SubmitterUserId INT NOT NULL,
  Status VARCHAR(20) NOT NULL CONSTRAINT CK_Requests_Status
    CHECK (Status IN ('InProgress','Approved','Rejected','Cancelled')),
  CurrentStepOrder INT NULL,
  TotalSteps INT NOT NULL,
  SubmittedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Requests_SubmittedAt DEFAULT SYSUTCDATETIME(),
  SubmittedIp VARCHAR(45) NULL,
  ClosedAt DATETIME2(3) NULL,
  RejectedRequestStepId INT NULL,
  RejectionReason NVARCHAR(2000) NULL,
  CancelledBy INT NULL,
  CancelReason NVARCHAR(1000) NULL,
  ArchiveStatus VARCHAR(20) NOT NULL CONSTRAINT DF_Requests_Archive DEFAULT 'None'
    CONSTRAINT CK_Requests_Archive CHECK (ArchiveStatus IN ('None','PdfPending','PendingUpload','Uploaded','Failed')),
  PdfLocalPath NVARCHAR(400) NULL,
  PdfSha256 VARBINARY(32) NULL,
  SharePointUrl NVARCHAR(1000) NULL,
  SharePointItemId NVARCHAR(200) NULL,
  UploadAttempts INT NOT NULL CONSTRAINT DF_Requests_Attempts DEFAULT 0,
  NextUploadAttemptAt DATETIME2(3) NULL,
  LastUploadError NVARCHAR(2000) NULL,
  RowVer ROWVERSION,
  CONSTRAINT UQ_Requests_Number UNIQUE (TenantId, RequestNumber),
  CONSTRAINT UQ_Requests_Tenant_Id UNIQUE (TenantId, RequestId),
  CONSTRAINT CK_Requests_RejectReason CHECK (Status <> 'Rejected' OR LEN(LTRIM(RTRIM(RejectionReason))) > 0),
  CONSTRAINT CK_Requests_CurrentStep CHECK (
    (Status = 'InProgress' AND CurrentStepOrder IS NOT NULL) OR (Status <> 'InProgress' AND CurrentStepOrder IS NULL)),
  CONSTRAINT FK_Requests_Form FOREIGN KEY (TenantId, FormId) REFERENCES Forms (TenantId, FormId),
  CONSTRAINT FK_Requests_Chain FOREIGN KEY (TenantId, ChainId) REFERENCES ApprovalChains (TenantId, ChainId),
  CONSTRAINT FK_Requests_Submitter FOREIGN KEY (TenantId, SubmitterUserId) REFERENCES Users (TenantId, UserId)
);
CREATE INDEX IX_Requests_Status ON Requests (TenantId, Status, SubmittedAt DESC);
CREATE INDEX IX_Requests_Submitter ON Requests (TenantId, SubmitterUserId, SubmittedAt DESC);
CREATE INDEX IX_Requests_Archive ON Requests (ArchiveStatus, NextUploadAttemptAt) WHERE ArchiveStatus IN ('PdfPending','PendingUpload');

-- Per-tenant request number counter (REQ-000001 ...)
CREATE TABLE RequestCounters (
  TenantId INT NOT NULL PRIMARY KEY REFERENCES Tenants (TenantId),
  LastNumber INT NOT NULL CONSTRAINT DF_RequestCounters_Last DEFAULT 0
);

CREATE TABLE RequestData (
  RequestDataId BIGINT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  RequestId INT NOT NULL,
  FieldId INT NOT NULL,
  FieldKey VARCHAR(100) NOT NULL,
  FieldLabel NVARCHAR(200) NOT NULL,
  FieldType VARCHAR(20) NOT NULL,
  SortOrder INT NOT NULL,
  Value NVARCHAR(MAX) NULL,
  CONSTRAINT UQ_RequestData_Key UNIQUE (TenantId, RequestId, FieldKey),
  CONSTRAINT FK_RequestData_Request FOREIGN KEY (TenantId, RequestId) REFERENCES Requests (TenantId, RequestId),
  CONSTRAINT FK_RequestData_Field FOREIGN KEY (TenantId, FieldId) REFERENCES FormFields (TenantId, FieldId)
);

CREATE TABLE RequestSteps (
  RequestStepId INT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  RequestId INT NOT NULL,
  StepId INT NOT NULL,
  StepOrder INT NOT NULL,
  StepName NVARCHAR(200) NOT NULL,
  AssignedUserId INT NOT NULL,
  DelegateUserId INT NULL,
  Status VARCHAR(20) NOT NULL CONSTRAINT CK_RequestSteps_Status
    CHECK (Status IN ('Waiting','Active','Approved','Rejected','Cancelled','NotReached')),
  ActivatedAt DATETIME2(3) NULL,
  DueAt DATETIME2(3) NULL,
  ActedAt DATETIME2(3) NULL,
  ActedByUserId INT NULL,
  ActedIp VARCHAR(45) NULL,
  Comments NVARCHAR(4000) NULL,
  LastReminderAt DATETIME2(3) NULL,
  ReminderCount INT NOT NULL CONSTRAINT DF_RequestSteps_Reminders DEFAULT 0,
  EscalatedAt DATETIME2(3) NULL,
  RowVer ROWVERSION,
  CONSTRAINT UQ_RequestSteps_Order UNIQUE (TenantId, RequestId, StepOrder),
  CONSTRAINT UQ_RequestSteps_Tenant_Id UNIQUE (TenantId, RequestStepId),
  CONSTRAINT FK_RequestSteps_Request FOREIGN KEY (TenantId, RequestId) REFERENCES Requests (TenantId, RequestId),
  CONSTRAINT FK_RequestSteps_Step FOREIGN KEY (TenantId, StepId) REFERENCES ApprovalSteps (TenantId, StepId),
  CONSTRAINT FK_RequestSteps_Assigned FOREIGN KEY (TenantId, AssignedUserId) REFERENCES Users (TenantId, UserId),
  CONSTRAINT FK_RequestSteps_Delegate FOREIGN KEY (TenantId, DelegateUserId) REFERENCES Users (TenantId, UserId),
  CONSTRAINT FK_RequestSteps_ActedBy FOREIGN KEY (TenantId, ActedByUserId) REFERENCES Users (TenantId, UserId)
);
CREATE INDEX IX_RequestSteps_Assigned ON RequestSteps (TenantId, AssignedUserId, Status);
CREATE INDEX IX_RequestSteps_Due ON RequestSteps (Status, DueAt) WHERE Status = 'Active';

ALTER TABLE Requests ADD CONSTRAINT FK_Requests_RejectedStep
  FOREIGN KEY (TenantId, RejectedRequestStepId) REFERENCES RequestSteps (TenantId, RequestStepId);

CREATE TABLE StepResponses (
  StepResponseId BIGINT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  RequestStepId INT NOT NULL,
  StepFieldId INT NOT NULL,
  FieldKey VARCHAR(100) NOT NULL,
  FieldLabel NVARCHAR(200) NOT NULL,
  FieldType VARCHAR(20) NOT NULL,
  SortOrder INT NOT NULL,
  Value NVARCHAR(MAX) NULL,
  CONSTRAINT UQ_StepResponses_Key UNIQUE (TenantId, RequestStepId, FieldKey),
  CONSTRAINT FK_StepResponses_RequestStep FOREIGN KEY (TenantId, RequestStepId) REFERENCES RequestSteps (TenantId, RequestStepId),
  CONSTRAINT FK_StepResponses_Field FOREIGN KEY (TenantId, StepFieldId) REFERENCES StepFields (TenantId, StepFieldId)
);

CREATE TABLE ApprovalTokens (
  TokenId BIGINT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  RequestStepId INT NOT NULL,
  UserId INT NOT NULL,
  TokenHash VARBINARY(32) NOT NULL CONSTRAINT UQ_ApprovalTokens_Hash UNIQUE,
  ExpiresAt DATETIME2(3) NOT NULL,
  ConsumedAt DATETIME2(3) NULL,
  RevokedAt DATETIME2(3) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ApprovalTokens_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_ApprovalTokens_RequestStep FOREIGN KEY (TenantId, RequestStepId) REFERENCES RequestSteps (TenantId, RequestStepId),
  CONSTRAINT FK_ApprovalTokens_User FOREIGN KEY (TenantId, UserId) REFERENCES Users (TenantId, UserId)
);

CREATE TABLE Notifications (
  NotificationId BIGINT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL REFERENCES Tenants (TenantId),
  RequestId INT NULL,
  RequestStepId INT NULL,
  Type VARCHAR(40) NOT NULL,
  RecipientUserId INT NULL,
  RecipientEmail NVARCHAR(320) NOT NULL,
  Subject NVARCHAR(300) NOT NULL,
  BodyHtml NVARCHAR(MAX) NOT NULL,
  Status VARCHAR(20) NOT NULL CONSTRAINT DF_Notifications_Status DEFAULT 'Queued'
    CONSTRAINT CK_Notifications_Status CHECK (Status IN ('Queued','Sent','Failed')),
  Attempts INT NOT NULL CONSTRAINT DF_Notifications_Attempts DEFAULT 0,
  NextAttemptAt DATETIME2(3) NULL,
  SentAt DATETIME2(3) NULL,
  LastError NVARCHAR(2000) NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_Notifications_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_Notifications_Request FOREIGN KEY (TenantId, RequestId) REFERENCES Requests (TenantId, RequestId)
);
CREATE INDEX IX_Notifications_Queue ON Notifications (Status, NextAttemptAt) WHERE Status = 'Queued';

CREATE TABLE AuditLog (
  AuditId BIGINT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL REFERENCES Tenants (TenantId),
  OccurredAt DATETIME2(3) NOT NULL CONSTRAINT DF_AuditLog_OccurredAt DEFAULT SYSUTCDATETIME(),
  UserId INT NULL,
  IpAddress VARCHAR(45) NULL,
  UserAgent NVARCHAR(400) NULL,
  Action VARCHAR(60) NOT NULL,
  EntityType VARCHAR(40) NOT NULL,
  EntityId BIGINT NULL,
  RequestId INT NULL,
  FromState VARCHAR(30) NULL,
  ToState VARCHAR(30) NULL,
  DetailJson NVARCHAR(MAX) NULL
);
CREATE INDEX IX_AuditLog_Time ON AuditLog (TenantId, OccurredAt DESC);
CREATE INDEX IX_AuditLog_Request ON AuditLog (TenantId, RequestId) WHERE RequestId IS NOT NULL;

CREATE TABLE SharePointConfig (
  ConfigId INT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  FormId INT NOT NULL,
  SiteId NVARCHAR(300) NOT NULL,
  ApprovedDriveId NVARCHAR(200) NOT NULL,
  ApprovedFolderPath NVARCHAR(400) NOT NULL CONSTRAINT DF_SP_ApprovedFolder DEFAULT '/',
  RejectedDriveId NVARCHAR(200) NOT NULL,
  RejectedFolderPath NVARCHAR(400) NOT NULL CONSTRAINT DF_SP_RejectedFolder DEFAULT '/',
  CONSTRAINT UQ_SharePointConfig_Form UNIQUE (TenantId, FormId),
  CONSTRAINT FK_SharePointConfig_Form FOREIGN KEY (TenantId, FormId) REFERENCES Forms (TenantId, FormId)
);
GO

-- Immutability guards. Triggers apply to every login, including sysadmin.
CREATE TRIGGER TR_AuditLog_Immutable ON AuditLog INSTEAD OF UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  THROW 51000, 'AuditLog is append-only.', 1;
END
GO

CREATE TRIGGER TR_StepResponses_Immutable ON StepResponses INSTEAD OF UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  THROW 51001, 'StepResponses are immutable once written.', 1;
END
GO

CREATE TRIGGER TR_RequestSteps_Immutable ON RequestSteps AFTER UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS (SELECT 1 FROM deleted WHERE Status IN ('Approved','Rejected','Cancelled','NotReached'))
    THROW 51002, 'A completed request step cannot be modified.', 1;
END
GO

CREATE TRIGGER TR_Requests_Final ON Requests AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  -- Terminal requests may still have archive/upload columns updated, but the outcome is frozen.
  IF EXISTS (
    SELECT 1 FROM deleted d JOIN inserted i ON i.RequestId = d.RequestId
    WHERE d.Status <> 'InProgress'
      AND (i.Status <> d.Status
           OR ISNULL(i.RejectionReason, N'') <> ISNULL(d.RejectionReason, N'')
           OR ISNULL(i.RejectedRequestStepId, 0) <> ISNULL(d.RejectedRequestStepId, 0)))
    THROW 51003, 'A closed request is final.', 1;
END
GO
