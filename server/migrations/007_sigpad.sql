-- 'sigpad' control: a signature drawn with a stylus, finger or mouse. The pen strokes are stored as JSON in the existing Value column.
ALTER TABLE FormFields DROP CONSTRAINT CK_FormFields_Type;
ALTER TABLE StepFields DROP CONSTRAINT CK_StepFields_Type;
GO
ALTER TABLE FormFields ADD CONSTRAINT CK_FormFields_Type CHECK (FieldType IN (
  'text','textarea','number','currency','date','select','checkbox','email','signature','sigpad',
  'tel','url','time','datetime','month','week','color','range','radio','multiselect','lookup','grid',
  'heading','paragraph','divider'));
ALTER TABLE StepFields ADD CONSTRAINT CK_StepFields_Type CHECK (FieldType IN (
  'text','textarea','number','currency','date','select','checkbox','email','signature','sigpad',
  'tel','url','time','datetime','month','week','color','range','radio','multiselect','lookup','grid',
  'heading','paragraph','divider'));
GO
