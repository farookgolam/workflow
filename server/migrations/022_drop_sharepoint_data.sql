-- 022: the data left from the SharePoint archive (removed from the application in 021) is dropped for good:
-- the per-form destinations, the SharePoint / Microsoft Graph settings of each customer, and the upload
-- bookkeeping on each request. PDFs are kept in RequestDocuments only.
--
-- Kept: Requests.NextUploadAttemptAt (the archive worker's lease column, despite its name), Requests.PdfLocalPath
-- and PdfSha256 (used to copy PDFs archived as files before 019 into the database).

-- a column's default and check constraints have to go before the column itself
CREATE PROCEDURE #DropColumn @Table SYSNAME, @Column SYSNAME AS
BEGIN
  DECLARE @sql NVARCHAR(MAX) = N'';
  SELECT @sql += N'ALTER TABLE ' + QUOTENAME(@Table) + N' DROP CONSTRAINT ' + QUOTENAME(d.name) + N'; '
    FROM sys.default_constraints d JOIN sys.columns c ON c.object_id = d.parent_object_id AND c.column_id = d.parent_column_id
   WHERE d.parent_object_id = OBJECT_ID(@Table) AND c.name = @Column;
  SELECT @sql += N'ALTER TABLE ' + QUOTENAME(@Table) + N' DROP CONSTRAINT ' + QUOTENAME(k.name) + N'; '
    FROM sys.check_constraints k JOIN sys.columns c ON c.object_id = k.parent_object_id AND c.column_id = k.parent_column_id
   WHERE k.parent_object_id = OBJECT_ID(@Table) AND c.name = @Column;
  IF COL_LENGTH(@Table, @Column) IS NOT NULL SET @sql += N'ALTER TABLE ' + QUOTENAME(@Table) + N' DROP COLUMN ' + QUOTENAME(@Column) + N';';
  EXEC (@sql);
END
GO

DROP TABLE SharePointConfig;
GO

EXEC #DropColumn 'TenantSettings', 'SharePointMode';
EXEC #DropColumn 'TenantSettings', 'ArchiveDestination';
EXEC #DropColumn 'TenantSettings', 'GraphTenantId';
EXEC #DropColumn 'TenantSettings', 'GraphClientId';
EXEC #DropColumn 'TenantSettings', 'GraphClientSecret';
EXEC #DropColumn 'Requests', 'SharePointUrl';
EXEC #DropColumn 'Requests', 'SharePointItemId';
EXEC #DropColumn 'Requests', 'UploadAttempts';
EXEC #DropColumn 'Requests', 'LastUploadError';
GO

-- only three archive states remain
DROP INDEX IX_Requests_Archive ON Requests;
ALTER TABLE Requests DROP CONSTRAINT CK_Requests_Archive;
ALTER TABLE Requests ADD CONSTRAINT CK_Requests_Archive CHECK (ArchiveStatus IN ('None','PdfPending','Stored'));
CREATE INDEX IX_Requests_Archive ON Requests (ArchiveStatus, NextUploadAttemptAt) WHERE ArchiveStatus = 'PdfPending';
GO

DROP PROCEDURE #DropColumn;
GO

-- removing a customer no longer has SharePoint settings to clear
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
