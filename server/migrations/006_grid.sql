-- 'grid' control: repeating rows with typed and calculated columns. Column definitions live in PropsJson;
-- the submitted rows (with the server's calculated cells and totals) are stored as JSON in the existing Value column.
ALTER TABLE FormFields DROP CONSTRAINT CK_FormFields_Type;
ALTER TABLE StepFields DROP CONSTRAINT CK_StepFields_Type;
GO
ALTER TABLE FormFields ADD CONSTRAINT CK_FormFields_Type CHECK (FieldType IN (
  'text','textarea','number','currency','date','select','checkbox','email','signature',
  'tel','url','time','datetime','month','week','color','range','radio','multiselect','lookup','grid',
  'heading','paragraph','divider'));
ALTER TABLE StepFields ADD CONSTRAINT CK_StepFields_Type CHECK (FieldType IN (
  'text','textarea','number','currency','date','select','checkbox','email','signature',
  'tel','url','time','datetime','month','week','color','range','radio','multiselect','lookup','grid',
  'heading','paragraph','divider'));
GO
