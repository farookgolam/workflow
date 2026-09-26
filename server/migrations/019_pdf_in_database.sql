-- 019: the archived PDF of a closed request is kept in the database.
--
-- Until now the PDF was written to STORAGE_DIR/pdf and uploaded to SharePoint. Now it is stored here, in
-- RequestDocuments, and SharePoint is optional per customer (TenantSettings.ArchiveDestination):
--   database   - kept here only; the request's ArchiveStatus becomes 'Stored'
--   sharepoint - kept here AND uploaded, as before ('PendingUpload' -> 'Uploaded')
--   both       - the same as sharepoint; kept for clarity in the settings screen
-- NULL inherits the server default (ARCHIVE_DESTINATION, 'database' unless set).
--
-- A stored PDF is a record of what was decided, so it is as unchangeable as the audit log: a trigger refuses
-- every UPDATE and DELETE, except dbo.PurgeTenant removing a suspended customer (migration 016's pattern).

CREATE TABLE RequestDocuments (
  DocumentId BIGINT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  RequestId INT NOT NULL,
  FileName NVARCHAR(260) NOT NULL,
  ContentType VARCHAR(100) NOT NULL CONSTRAINT DF_RequestDocuments_Type DEFAULT 'application/pdf',
  SizeBytes INT NOT NULL,
  Sha256 BINARY(32) NOT NULL,
  Content VARBINARY(MAX) NOT NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_RequestDocuments_CreatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_RequestDocuments_Request UNIQUE (TenantId, RequestId),
  CONSTRAINT FK_RequestDocuments_Request FOREIGN KEY (TenantId, RequestId) REFERENCES Requests (TenantId, RequestId)
);
GO

CREATE TRIGGER TR_RequestDocuments_Immutable ON RequestDocuments INSTEAD OF UPDATE, DELETE AS
BEGIN
  SET NOCOUNT ON;
  DECLARE @purge INT = TRY_CAST(SESSION_CONTEXT(N'af.purge_tenant') AS INT);
  IF NOT EXISTS (SELECT 1 FROM inserted)
     AND @purge IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM deleted WHERE TenantId <> @purge)
     AND EXISTS (SELECT 1 FROM Tenants WHERE TenantId = @purge AND IsActive = 0)
  BEGIN
    DELETE d FROM RequestDocuments d JOIN deleted x ON x.DocumentId = d.DocumentId;
    RETURN;
  END;
  THROW 51004, 'A stored request document cannot be changed or deleted.', 1;
END
GO

-- 'Stored': archived in the database, nothing to upload
ALTER TABLE Requests DROP CONSTRAINT CK_Requests_Archive;
ALTER TABLE Requests ADD CONSTRAINT CK_Requests_Archive CHECK (ArchiveStatus IN ('None','PdfPending','Stored','PendingUpload','Uploaded','Failed'));
GO

ALTER TABLE TenantSettings ADD ArchiveDestination VARCHAR(10) NULL
  CONSTRAINT CK_TenantSettings_ArchiveDestination CHECK (ArchiveDestination IS NULL OR ArchiveDestination IN ('database','sharepoint','both'));
GO

-- removing a customer now also removes its stored documents (before its requests)
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
