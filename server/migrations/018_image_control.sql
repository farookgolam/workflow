-- 'image' control: a picture (a logo, a diagram) shown on the form. A layout element like 'heading': nothing is
-- submitted or stored for it. The picture itself travels in PropsJson as a data: URL (props.imageDataUrl).
ALTER TABLE FormFields DROP CONSTRAINT CK_FormFields_Type;
ALTER TABLE StepFields DROP CONSTRAINT CK_StepFields_Type;
GO
ALTER TABLE FormFields ADD CONSTRAINT CK_FormFields_Type CHECK (FieldType IN (
  'text','textarea','number','currency','date','select','checkbox','email','signature','sigpad',
  'tel','url','time','datetime','month','week','color','range','radio','multiselect','lookup','grid',
  'heading','paragraph','divider','image'));
ALTER TABLE StepFields ADD CONSTRAINT CK_StepFields_Type CHECK (FieldType IN (
  'text','textarea','number','currency','date','select','checkbox','email','signature','sigpad',
  'tel','url','time','datetime','month','week','color','range','radio','multiselect','lookup','grid',
  'heading','paragraph','divider','image'));
GO
