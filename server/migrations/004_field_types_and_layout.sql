-- 004: more control types and per-field presentation settings (width on the 12-column grid,
-- text-area height, placeholder, help text, default value, static text...).
ALTER TABLE FormFields DROP CONSTRAINT CK_FormFields_Type;
ALTER TABLE StepFields DROP CONSTRAINT CK_StepFields_Type;
GO

ALTER TABLE FormFields ADD PropsJson NVARCHAR(MAX) NULL;
ALTER TABLE StepFields ADD PropsJson NVARCHAR(MAX) NULL;
GO

ALTER TABLE FormFields ADD CONSTRAINT CK_FormFields_Type CHECK (FieldType IN (
  'text','textarea','number','currency','date','select','checkbox','email','signature',
  'tel','url','time','datetime','month','week','color','range','radio','multiselect',
  'heading','paragraph','divider'));
ALTER TABLE StepFields ADD CONSTRAINT CK_StepFields_Type CHECK (FieldType IN (
  'text','textarea','number','currency','date','select','checkbox','email','signature',
  'tel','url','time','datetime','month','week','color','range','radio','multiselect',
  'heading','paragraph','divider'));
GO
