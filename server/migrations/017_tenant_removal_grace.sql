-- 017: removing a customer keeps its data for a grace period before it is purged.
--
-- "Remove" now only stamps RemovedAt and PurgeAfter on a suspended customer. Its rows, files, slug and host
-- stay exactly as they are, so a global administrator can restore it until PurgeAfter. After that, the
-- tenant purge job (src/platform/purge.ts) runs dbo.PurgeTenant (migration 016) on it.
ALTER TABLE Tenants ADD
  RemovedAt DATETIME2(3) NULL,
  PurgeAfter DATETIME2(3) NULL;
GO

CREATE INDEX IX_Tenants_PurgeAfter ON Tenants (PurgeAfter) WHERE PurgeAfter IS NOT NULL;
GO
