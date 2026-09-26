-- 003: deleting forms from the repository.
-- A form that already has requests cannot be physically removed (its requests, audit trail and PDFs
-- must survive), so it is marked deleted instead and hidden everywhere. A form with no requests is
-- removed outright by the application.
ALTER TABLE Forms ADD DeletedAt DATETIME2(3) NULL, DeletedBy INT NULL;
GO
