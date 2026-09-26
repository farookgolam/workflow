-- The list of people a step can be sent to may come from a lookup table (a spreadsheet of approvers):
-- ApproverListLookupId is the table, ApproverListEmailColumn the column holding each person's sign-in email (it may be
-- the key column), ApproverListColumnsJson the columns shown - read-only - next to the chosen person.
ALTER TABLE ApprovalSteps ADD ApproverListLookupId INT NULL, ApproverListEmailColumn NVARCHAR(100) NULL, ApproverListColumnsJson NVARCHAR(MAX) NULL;
GO
