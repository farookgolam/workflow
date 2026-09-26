-- 016: a global administrator can remove a customer permanently.
--
-- Customer history is deliberately hard to delete: triggers make AuditLog and StepResponses append-only
-- and freeze completed approvals, and the runtime account is DENYed DELETE on those tables. Removing a
-- customer therefore goes through ONE procedure, dbo.PurgeTenant. It runs through ownership chaining
-- (so the DENYs don't apply inside it), and marks its session with SESSION_CONTEXT 'af.purge_tenant'. The
-- triggers let a delete through only when that mark names the rows' own customer AND that customer is
-- already suspended. Everything else, including every UPDATE of history, is refused exactly as before.
--
-- The global audit log is never purged. Its TenantId stops being a foreign key so the record of a
-- removed customer ("tenant.deleted", with its name and slug) outlives the customer.

DECLARE @fk SYSNAME = (
  SELECT fk.name FROM sys.foreign_keys fk
   WHERE fk.parent_object_id = OBJECT_ID('dbo.PlatformAuditLog') AND fk.referenced_object_id = OBJECT_ID('dbo.Tenants'));
DECLARE @drop NVARCHAR(400) = N'ALTER TABLE dbo.PlatformAuditLog DROP CONSTRAINT ' + QUOTENAME(@fk);
IF @fk IS NOT NULL EXEC (@drop);
GO

ALTER TRIGGER TR_AuditLog_Immutable ON AuditLog INSTEAD OF UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @purge INT = TRY_CAST(SESSION_CONTEXT(N'af.purge_tenant') AS INT);
  IF NOT EXISTS (SELECT 1 FROM inserted)
     AND @purge IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM deleted WHERE TenantId <> @purge)
     AND EXISTS (SELECT 1 FROM Tenants WHERE TenantId = @purge AND IsActive = 0)
  BEGIN
    DELETE a FROM AuditLog a JOIN deleted d ON d.AuditId = a.AuditId;
    RETURN;
  END;
  THROW 51000, 'AuditLog is append-only.', 1;
END
GO

ALTER TRIGGER TR_StepResponses_Immutable ON StepResponses INSTEAD OF UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @purge INT = TRY_CAST(SESSION_CONTEXT(N'af.purge_tenant') AS INT);
  IF NOT EXISTS (SELECT 1 FROM inserted)
     AND @purge IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM deleted WHERE TenantId <> @purge)
     AND EXISTS (SELECT 1 FROM Tenants WHERE TenantId = @purge AND IsActive = 0)
  BEGIN
    DELETE s FROM StepResponses s JOIN deleted d ON d.StepResponseId = s.StepResponseId;
    RETURN;
  END;
  THROW 51001, 'StepResponses are immutable once written.', 1;
END
GO

ALTER TRIGGER TR_RequestSteps_Immutable ON RequestSteps AFTER UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @purge INT = TRY_CAST(SESSION_CONTEXT(N'af.purge_tenant') AS INT);
  IF NOT EXISTS (SELECT 1 FROM inserted)
     AND @purge IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM deleted WHERE TenantId <> @purge)
     AND EXISTS (SELECT 1 FROM Tenants WHERE TenantId = @purge AND IsActive = 0)
    RETURN;
  IF EXISTS (SELECT 1 FROM deleted WHERE Status IN ('Approved','Rejected','Cancelled','NotReached'))
    THROW 51002, 'A completed request step cannot be modified.', 1;
END
GO

ALTER TRIGGER TR_Requests_Final ON Requests AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  -- the purge has to clear RejectedRequestStepId before it can delete the steps that column points at
  DECLARE @purge INT = TRY_CAST(SESSION_CONTEXT(N'af.purge_tenant') AS INT);
  IF @purge IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM deleted WHERE TenantId <> @purge)
     AND EXISTS (SELECT 1 FROM Tenants WHERE TenantId = @purge AND IsActive = 0)
    RETURN;
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

-- Deletes every row that belongs to one suspended customer, children before parents, in one transaction.
CREATE PROCEDURE dbo.PurgeTenant @TenantId INT AS
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

    DELETE FROM ApprovalTokens     WHERE TenantId = @TenantId;
    DELETE FROM StepResponses      WHERE TenantId = @TenantId;
    DELETE FROM Notifications      WHERE TenantId = @TenantId;
    DELETE FROM RequestData        WHERE TenantId = @TenantId;
    DELETE FROM RequestSteps       WHERE TenantId = @TenantId;
    DELETE FROM Requests           WHERE TenantId = @TenantId;
    DELETE FROM RequestCounters    WHERE TenantId = @TenantId;
    DELETE FROM SharePointConfig   WHERE TenantId = @TenantId;
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
