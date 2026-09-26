-- 023: each approval step says how ITS approver is found.
--
--   ApproverChosen = 0  the step always goes to ApprovalSteps.ApproverUserId.
--   ApproverChosen = 1  the person before it chooses: the submitter for step 1, the approver of step N-1 for step N.
--                       They choose from the step's lookup file (ApproverList*), or - with no file - from everyone
--                       with the Approver role. ApproverUserId only holds a placeholder until then.
--
-- Until now the choice was set up in the stage BEFORE the step: a lookup control of the submission form (for step 1)
-- or of step N-1's section, marked "chooses the next approver" (props.approverEmailColumn / approverNameColumn).
-- Those steps become chosen from that control's lookup file, with the same email and name columns; the control
-- itself stays where it is, as an ordinary control. Every chain version is converted, so requests already in
-- progress carry on. Also gone: ApproverSelectable (a chosen step is always choosable, a fixed one never) and the
-- never-used ApproverLookupField / ApproverLookupColumn binding.

-- step 1: from the submission form's chooser control (the current one, or the most recent)
UPDATE s
   SET ApproverListLookupId = TRY_CAST(JSON_VALUE(src.PropsJson, '$.lookupId') AS INT),
       ApproverListEmailColumn = JSON_VALUE(src.PropsJson, '$.approverEmailColumn'),
       ApproverListNameColumn = JSON_VALUE(src.PropsJson, '$.approverNameColumn')
  FROM ApprovalSteps s
  JOIN ApprovalChains c ON c.TenantId = s.TenantId AND c.ChainId = s.ChainId
 CROSS APPLY (SELECT TOP 1 f.PropsJson FROM FormFields f
               WHERE f.TenantId = c.TenantId AND f.FormId = c.FormId AND f.FieldType = 'lookup'
                 AND JSON_VALUE(f.PropsJson, '$.approverEmailColumn') IS NOT NULL
               ORDER BY f.IsActive DESC, f.FieldId DESC) src
 WHERE s.ApproverFromControl = 1 AND s.StepOrder = 1;

-- step N: from the chooser control of step N-1 of the same chain version
UPDATE s
   SET ApproverListLookupId = TRY_CAST(JSON_VALUE(src.PropsJson, '$.lookupId') AS INT),
       ApproverListEmailColumn = JSON_VALUE(src.PropsJson, '$.approverEmailColumn'),
       ApproverListNameColumn = JSON_VALUE(src.PropsJson, '$.approverNameColumn')
  FROM ApprovalSteps s
 CROSS APPLY (SELECT TOP 1 sf.PropsJson FROM StepFields sf
                JOIN ApprovalSteps p ON p.TenantId = sf.TenantId AND p.StepId = sf.StepId
               WHERE p.TenantId = s.TenantId AND p.ChainId = s.ChainId AND p.StepOrder = s.StepOrder - 1
                 AND sf.FieldType = 'lookup' AND JSON_VALUE(sf.PropsJson, '$.approverEmailColumn') IS NOT NULL) src
 WHERE s.ApproverFromControl = 1 AND s.StepOrder > 1;

-- a step with an approver file was always choosable; it is now marked so
UPDATE ApprovalSteps SET ApproverFromControl = 1 WHERE ApproverListLookupId IS NOT NULL;
GO

EXEC sp_rename 'dbo.ApprovalSteps.ApproverFromControl', 'ApproverChosen', 'COLUMN';
GO

-- the controls stay, without the "chooses the next approver" settings
UPDATE FormFields SET PropsJson = JSON_MODIFY(JSON_MODIFY(PropsJson, '$.approverEmailColumn', NULL), '$.approverNameColumn', NULL)
 WHERE JSON_VALUE(PropsJson, '$.approverEmailColumn') IS NOT NULL OR JSON_VALUE(PropsJson, '$.approverNameColumn') IS NOT NULL;
UPDATE StepFields SET PropsJson = JSON_MODIFY(JSON_MODIFY(PropsJson, '$.approverEmailColumn', NULL), '$.approverNameColumn', NULL)
 WHERE JSON_VALUE(PropsJson, '$.approverEmailColumn') IS NOT NULL OR JSON_VALUE(PropsJson, '$.approverNameColumn') IS NOT NULL;
GO

-- columns no longer used (their default constraint first)
DECLARE @sql NVARCHAR(MAX) = N'';
SELECT @sql += N'ALTER TABLE dbo.ApprovalSteps DROP CONSTRAINT ' + QUOTENAME(d.name) + N'; '
  FROM sys.default_constraints d JOIN sys.columns c ON c.object_id = d.parent_object_id AND c.column_id = d.parent_column_id
 WHERE d.parent_object_id = OBJECT_ID('dbo.ApprovalSteps') AND c.name IN ('ApproverSelectable', 'ApproverLookupField', 'ApproverLookupColumn');
EXEC (@sql);
GO
ALTER TABLE ApprovalSteps DROP COLUMN ApproverSelectable, ApproverLookupField, ApproverLookupColumn;
GO
