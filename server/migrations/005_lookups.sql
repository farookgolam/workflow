-- 005: lookup tables imported from Excel. A "lookup" control on a form offers the table's key values;
-- other controls can be auto-filled from the chosen row's columns.
CREATE TABLE LookupTables (
  LookupId INT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL REFERENCES Tenants (TenantId),
  Name NVARCHAR(200) NOT NULL,
  KeyColumn NVARCHAR(100) NOT NULL,
  ColumnsJson NVARCHAR(MAX) NOT NULL,           -- ["School","Department","Secretary","Email"], key column included
  [RowCount] INT NOT NULL CONSTRAINT DF_LookupTables_RowCount DEFAULT 0,
  SourceFileName NVARCHAR(260) NULL,
  CreatedBy INT NOT NULL,
  CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_LookupTables_CreatedAt DEFAULT SYSUTCDATETIME(),
  UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_LookupTables_UpdatedAt DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_LookupTables_Name UNIQUE (TenantId, Name),
  CONSTRAINT UQ_LookupTables_Tenant_Id UNIQUE (TenantId, LookupId),
  CONSTRAINT FK_LookupTables_CreatedBy FOREIGN KEY (TenantId, CreatedBy) REFERENCES Users (TenantId, UserId)
);

CREATE TABLE LookupRows (
  LookupRowId BIGINT IDENTITY PRIMARY KEY,
  TenantId INT NOT NULL,
  LookupId INT NOT NULL,
  KeyValue NVARCHAR(400) NOT NULL,
  DataJson NVARCHAR(MAX) NOT NULL,              -- {"Department":"Elementary","Secretary":"...","Email":"..."}
  SortOrder INT NOT NULL,
  CONSTRAINT UQ_LookupRows_Key UNIQUE (TenantId, LookupId, KeyValue),
  CONSTRAINT FK_LookupRows_Table FOREIGN KEY (TenantId, LookupId) REFERENCES LookupTables (TenantId, LookupId)
);
GO

ALTER TABLE FormFields DROP CONSTRAINT CK_FormFields_Type;
ALTER TABLE StepFields DROP CONSTRAINT CK_StepFields_Type;
GO
ALTER TABLE FormFields ADD CONSTRAINT CK_FormFields_Type CHECK (FieldType IN (
  'text','textarea','number','currency','date','select','checkbox','email','signature',
  'tel','url','time','datetime','month','week','color','range','radio','multiselect','lookup',
  'heading','paragraph','divider'));
ALTER TABLE StepFields ADD CONSTRAINT CK_StepFields_Type CHECK (FieldType IN (
  'text','textarea','number','currency','date','select','checkbox','email','signature',
  'tel','url','time','datetime','month','week','color','range','radio','multiselect','lookup',
  'heading','paragraph','divider'));
GO
