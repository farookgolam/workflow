-- 026: every approver signs when they approve a step.
--
-- RequestSteps.Signature holds the drawn signature as pen strokes on the fixed 600 x 200 pad (the same JSON as
-- the 'sigpad' control, 007). It is written in the same guarded UPDATE that records the decision, so
-- TR_RequestSteps_Immutable already freezes it with the rest of the step. Steps approved before this release,
-- and rejected steps, have none.

ALTER TABLE RequestSteps ADD Signature NVARCHAR(MAX) NULL;
GO
