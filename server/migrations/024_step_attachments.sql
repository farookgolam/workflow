-- 024: approvers can attach documents on a step.
--
-- ApprovalSteps.AllowAttachments turns it on per step (off for every existing step). The files themselves go
-- in StepAttachments, in the database like the archived PDF (019). An approver can remove a file they attached
-- while their step is still open; once the step is decided its files are part of the record, and the trigger
-- refuses every change - except dbo.PurgeTenant removing a suspended customer (016's pattern).
-- The submitter never sees them: only approvers of the request and administrators do (enforced in the app).

ALTER TABLE ApprovalSteps ADD AllowAttachments BIT NOT NULL CONSTRAINT DF_ApprovalSteps_AllowAttachments DEFAULT 0;
GO

CREATE TABLE StepAttachments (
  AttachmentId BIGINT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  RequestId INT NOT NULL,
  RequestStepId INT NOT NULL,
  FileName NVARCHAR(260) NOT NULL,
  ContentType VARCHAR(100) NOT NULL,
  SizeBytes INT NOT NULL,
  Sha256 BINARY(32) NOT NULL,
  Content VARBINARY(MAX) NOT NULL,
  UploadedByUserId INT NOT NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_StepAttachments_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_StepAttachments_Request FOREIGN KEY (TenantId, RequestId) REFERENCES Requests (TenantId, RequestId),
  CONSTRAINT FK_StepAttachments_Step FOREIGN KEY (TenantId, RequestStepId) REFERENCES RequestSteps (TenantId, RequestStepId),
  CONSTRAINT FK_StepAttachments_User FOREIGN KEY (TenantId, UploadedByUserId) REFERENCES Users (TenantId, UserId)
);
GO
CREATE INDEX IX_StepAttachments_Step ON StepAttachments (TenantId, RequestStepId);
CREATE INDEX IX_StepAttachments_Request ON StepAttachments (TenantId, RequestId);
GO

CREATE TRIGGER TR_StepAttachments_Guard ON StepAttachments INSTEAD OF UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS (SELECT 1 FROM inserted) THROW 51005, 'A stored attachment cannot be changed.', 1;

  DECLARE @purge INT = TRY_CAST(SESSION_CONTEXT(N'af.purge_tenant') AS INT);
  IF @purge IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM deleted WHERE TenantId <> @purge)
     AND EXISTS (SELECT 1 FROM Tenants WHERE TenantId = @purge AND IsActive = 0)
  BEGIN
    DELETE a FROM StepAttachments a JOIN deleted x ON x.AttachmentId = a.AttachmentId;
    RETURN;
  END;

  -- otherwise only while the step it belongs to is still open
  IF EXISTS (SELECT 1 FROM deleted x JOIN RequestSteps s ON s.TenantId = x.TenantId AND s.RequestStepId = x.RequestStepId
              WHERE s.Status <> 'Active')
    THROW 51006, 'An attachment on a decided step cannot be removed.', 1;
  DELETE a FROM StepAttachments a JOIN deleted x ON x.AttachmentId = a.AttachmentId;
END
GO

-- removing a customer also removes its attachments (before its requests and steps)
ALTER PROCEDURE dbo.PurgeTenant @TenantId INT AS
BEGIN
  SET NOCOUNT ON;
  SET XACT_ABORT ON;

  IF NOT EXISTS (SELECT 1 FROM Tenants WHERE TenantId = @TenantId)
    THROW 51010, 'No such organisation.', 1;
  IF EXISTS (SELECT 1 FROM Tenants WHERE TenantId = @TenantId AND IsActive = 1)
    THROW 51011, 'Suspend the organisation before removing it.', 1;

  EXEC sp_set_session_context N'af.purge_tenant', @TenantId;
  BEGIN TRY
    BEGIN TRANSACTION;

    UPDATE Requests SET RejectedRequestStepId = NULL WHERE TenantId = @TenantId AND RejectedRequestStepId IS NOT NULL;

    DELETE FROM SavedReports       WHERE TenantId = @TenantId;
    DELETE FROM StepAttachments    WHERE TenantId = @TenantId;
    DELETE FROM RequestDocuments   WHERE TenantId = @TenantId;
    DELETE FROM ApprovalTokens     WHERE TenantId = @TenantId;
    DELETE FROM StepResponses      WHERE TenantId = @TenantId;
    DELETE FROM Notifications      WHERE TenantId = @TenantId;
    DELETE FROM RequestData        WHERE TenantId = @TenantId;
    DELETE FROM RequestSteps       WHERE TenantId = @TenantId;
    DELETE FROM Requests           WHERE TenantId = @TenantId;
    DELETE FROM RequestCounters    WHERE TenantId = @TenantId;
    DELETE FROM StepFields         WHERE TenantId = @TenantId;
    DELETE FROM ApprovalSteps      WHERE TenantId = @TenantId;
    DELETE FROM ApprovalChains     WHERE TenantId = @TenantId;
    DELETE FROM FormFields         WHERE TenantId = @TenantId;
    DELETE FROM Forms              WHERE TenantId = @TenantId;
    DELETE FROM LookupRows         WHERE TenantId = @TenantId;
    DELETE FROM LookupTables       WHERE TenantId = @TenantId;
    DELETE FROM RefreshTokens      WHERE TenantId = @TenantId;
    DELETE FROM UserRoles          WHERE TenantId = @TenantId;
    DELETE FROM EmailVerifications WHERE TenantId = @TenantId;
    DELETE FROM AuditLog           WHERE TenantId = @TenantId;
    DELETE FROM TenantSettings     WHERE TenantId = @TenantId;
    DELETE FROM Users              WHERE TenantId = @TenantId;
    DELETE FROM Tenants            WHERE TenantId = @TenantId;

    COMMIT TRANSACTION;
    EXEC sp_set_session_context N'af.purge_tenant', NULL;
  END TRY
  BEGIN CATCH
    IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
    EXEC sp_set_session_context N'af.purge_tenant', NULL;
    THROW;
  END CATCH
END
GO
