-- The approver of a step can be chosen with a lookup control: one on the submission form decides step 1, one in a
-- step's own controls decides the step after it (the control's props carry approverEmailColumn / approverNameColumn).
-- ApproverFromControl marks such steps when the chain is published. ApproverUserId stays NOT NULL for them - it holds a
-- placeholder (the publishing administrator) that is always replaced before the step is activated.
ALTER TABLE ApprovalSteps ADD ApproverFromControl BIT NOT NULL CONSTRAINT DF_ApprovalSteps_ApproverFromControl DEFAULT 0;
GO
