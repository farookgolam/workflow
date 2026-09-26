-- 021: SharePoint archiving is removed from the application; a closed request's PDF is kept in the database only.
--
-- Requests the SharePoint pipeline was still working on become Stored when their PDF is in RequestDocuments,
-- and go back to PdfPending (the PDF is made again and stored) when it is not. Uploaded ones are Stored too:
-- their PDF was copied into the database when 019 was deployed.
--
-- Nothing is deleted. SharePointConfig, the SharePoint columns of TenantSettings and Requests.SharePointUrl
-- stay as they are, unused, so the history of what was uploaded where is not lost.
UPDATE r SET ArchiveStatus = 'Stored', NextUploadAttemptAt = NULL
  FROM Requests r
 WHERE r.ArchiveStatus IN ('PendingUpload', 'Uploaded', 'Failed')
   AND EXISTS (SELECT 1 FROM RequestDocuments d WHERE d.TenantId = r.TenantId AND d.RequestId = r.RequestId);

UPDATE r SET ArchiveStatus = 'PdfPending', NextUploadAttemptAt = NULL
  FROM Requests r
 WHERE r.ArchiveStatus IN ('PendingUpload', 'Uploaded', 'Failed')
   AND NOT EXISTS (SELECT 1 FROM RequestDocuments d WHERE d.TenantId = r.TenantId AND d.RequestId = r.RequestId);
GO
