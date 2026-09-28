-- 025: a customer's files can live in a folder of its own instead of the database.
--
-- Tenants.FileStorageRoot, set by a global administrator, is a folder on the server or a network share
-- (D:\CustomerFiles\Acme, \\fileserver\approvals\Acme). While it is set, that customer's NEW closed-request
-- PDFs and approvers' attachments are written there only: the row keeps FilePath and the SHA-256 of the file,
-- and Content stays NULL. A file whose bytes no longer match its fingerprint is refused, never served.
-- Rows written before (or while no folder is set) keep Content as before; changing the folder later only
-- affects new files, because each row remembers its own full path.

ALTER TABLE Tenants ADD FileStorageRoot NVARCHAR(400) NULL;
GO

ALTER TABLE RequestDocuments ALTER COLUMN Content VARBINARY(MAX) NULL;
ALTER TABLE RequestDocuments ADD FilePath NVARCHAR(700) NULL;
GO
ALTER TABLE RequestDocuments ADD CONSTRAINT CK_RequestDocuments_Where CHECK (Content IS NOT NULL OR FilePath IS NOT NULL);
GO

ALTER TABLE StepAttachments ALTER COLUMN Content VARBINARY(MAX) NULL;
ALTER TABLE StepAttachments ADD FilePath NVARCHAR(700) NULL;
GO
ALTER TABLE StepAttachments ADD CONSTRAINT CK_StepAttachments_Where CHECK (Content IS NOT NULL OR FilePath IS NOT NULL);
GO
