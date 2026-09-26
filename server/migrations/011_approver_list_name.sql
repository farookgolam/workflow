-- Approver spreadsheet: the column holding each person's name. It is what the Send-to drop-down shows and the display
-- name of an account created for someone chosen from the list. Empty = the key column.
ALTER TABLE ApprovalSteps ADD ApproverListNameColumn NVARCHAR(100) NULL;
GO
