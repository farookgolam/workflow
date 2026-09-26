-- A step's approver can come from the lookup row the submitter picked: ApproverLookupField is the key of a lookup
-- control of the submission form, ApproverLookupColumn the column of its table holding the approver's email.
-- ApproverUserId stays as the fallback when that email is not an active approver.
ALTER TABLE ApprovalSteps ADD ApproverLookupField NVARCHAR(100) NULL, ApproverLookupColumn NVARCHAR(100) NULL;
GO
