-- 027: an approver can send a request back to the submitter for changes; approval emails can show the details.
--
-- Send back: the approver's step goes Active -> Returned and the request stays InProgress (it is still open and
-- still at that step). The submitter edits the submission and resubmits; the same step goes Returned -> Active
-- and the chain carries on from there. 'Returned' is deliberately NOT one of the final step states in
-- TR_RequestSteps_Immutable, so the row can be reopened. Steps approved before the send-back keep their decision.
--
-- RequestReturns keeps each round: who sent it back, why, when it came back, what the submitter changed
-- (ChangesJson: [{ key, label, from, to }]) and their optional note. It is history, so it is only ever appended
-- to and then completed once (ResubmittedAt); the trigger refuses anything else, except dbo.PurgeTenant.
--
-- TenantSettings.EmailShowDetails: NULL or 1 = approval emails list the submitted values, 0 = they do not.

ALTER TABLE RequestSteps DROP CONSTRAINT CK_RequestSteps_Status;
ALTER TABLE RequestSteps ADD CONSTRAINT CK_RequestSteps_Status
  CHECK (Status IN ('Waiting','Active','Returned','Approved','Rejected','Cancelled','NotReached'));
GO

CREATE TABLE RequestReturns (
  ReturnId INT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  RequestId INT NOT NULL,
  RequestStepId INT NOT NULL,
  StepOrder INT NOT NULL,
  ReturnedByUserId INT NOT NULL,
  ReturnedAt DATETIME2(3) NOT NULL CONSTRAINT DF_RequestReturns_ReturnedAt DEFAULT SYSUTCDATETIME(),
  Reason NVARCHAR(2000) NOT NULL,
  ResubmittedAt DATETIME2(3) NULL,
  ResubmitNote NVARCHAR(2000) NULL,
  ChangesJson NVARCHAR(MAX) NULL,
  CONSTRAINT CK_RequestReturns_Reason CHECK (LEN(LTRIM(RTRIM(Reason))) > 0),
  CONSTRAINT FK_RequestReturns_Request FOREIGN KEY (TenantId, RequestId) REFERENCES Requests (TenantId, RequestId),
  CONSTRAINT FK_RequestReturns_Step FOREIGN KEY (TenantId, RequestStepId) REFERENCES RequestSteps (TenantId, RequestStepId),
  CONSTRAINT FK_RequestReturns_User FOREIGN KEY (TenantId, ReturnedByUserId) REFERENCES Users (TenantId, UserId)
);
GO
CREATE INDEX IX_RequestReturns_Request ON RequestReturns (TenantId, RequestId);
-- at most one open send-back per request
CREATE UNIQUE INDEX UQ_RequestReturns_Open ON RequestReturns (TenantId, RequestId) WHERE ResubmittedAt IS NULL;
GO

CREATE TRIGGER TR_RequestReturns_Guard ON RequestReturns AFTER UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @purge INT = TRY_CAST(SESSION_CONTEXT(N'af.purge_tenant') AS INT);
  IF NOT EXISTS (SELECT 1 FROM inserted)
  BEGIN
    IF @purge IS NULL OR EXISTS (SELECT 1 FROM deleted WHERE TenantId <> @purge)
       OR NOT EXISTS (SELECT 1 FROM Tenants WHERE TenantId = @purge AND IsActive = 0)
      THROW 51007, 'A send-back record cannot be removed.', 1;
    RETURN;
  END;
  -- the only change allowed: completing an open round, once
  IF EXISTS (SELECT 1 FROM deleted d JOIN inserted i ON i.ReturnId = d.ReturnId
              WHERE d.ResubmittedAt IS NOT NULL OR i.ResubmittedAt IS NULL
                 OR i.TenantId <> d.TenantId OR i.RequestId <> d.RequestId OR i.RequestStepId <> d.RequestStepId
                 OR i.StepOrder <> d.StepOrder OR i.ReturnedByUserId <> d.ReturnedByUserId
                 OR i.ReturnedAt <> d.ReturnedAt OR i.Reason <> d.Reason)
    THROW 51008, 'A send-back record can only be completed once.', 1;
END
GO

ALTER TABLE TenantSettings ADD EmailShowDetails BIT NULL;
GO

-- removing a customer also removes its send-back history (before its requests and steps)
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
    DELETE FROM RequestReturns     WHERE TenantId = @TenantId;
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
