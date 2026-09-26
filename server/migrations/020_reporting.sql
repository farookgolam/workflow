-- 020: reporting.
--
-- Every value people enter is already kept, as text, in RequestData (the submission) and StepResponses (each
-- approver's section). These computed columns give the same values as real numbers and dates, worked out by
-- SQL Server itself - nothing writes them, so the stored records stay exactly as they were. The app's own
-- reports (src/reports) read the text; the typed columns are for queries straight against the database
-- (Excel, Power BI) and for filtering by value in SQL.
ALTER TABLE RequestData ADD
  ValueNumber AS (CASE WHEN FieldType IN ('number','currency','range') THEN TRY_CONVERT(DECIMAL(19,6), Value) END) PERSISTED,
  ValueDate AS (CASE WHEN FieldType = 'date' THEN TRY_CONVERT(DATE, Value, 23) END); -- SQL Server will not persist a date conversion
GO
ALTER TABLE StepResponses ADD
  ValueNumber AS (CASE WHEN FieldType IN ('number','currency','range') THEN TRY_CONVERT(DECIMAL(19,6), Value) END) PERSISTED,
  ValueDate AS (CASE WHEN FieldType = 'date' THEN TRY_CONVERT(DATE, Value, 23) END); -- SQL Server will not persist a date conversion
GO
CREATE INDEX IX_RequestData_Key ON RequestData (TenantId, FieldKey) INCLUDE (RequestId, ValueNumber);
GO

-- A report an administrator saved to run again later. Every administrator of the organisation sees all of them.
CREATE TABLE SavedReports (
  ReportId INT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL REFERENCES Tenants (TenantId),
  Name NVARCHAR(200) NOT NULL,
  FormId INT NOT NULL,
  DefinitionJson NVARCHAR(MAX) NOT NULL,
  CreatedBy INT NOT NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_SavedReports_CreatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedBy INT NOT NULL,
  UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_SavedReports_UpdatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_SavedReports_Name UNIQUE (TenantId, Name)
);
GO

-- removing a customer also removes its saved reports
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
    DELETE FROM RequestDocuments   WHERE TenantId = @TenantId;
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
