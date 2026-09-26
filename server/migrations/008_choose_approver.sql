-- The person handing a request on (the submitter for step 1, each approver for the step after theirs) may pick
-- who receives it. The chain's approver stays the default; a step can be locked to that person by clearing this flag.
ALTER TABLE ApprovalSteps ADD ApproverSelectable BIT NOT NULL CONSTRAINT DF_ApprovalSteps_ApproverSelectable DEFAULT 1;
GO
