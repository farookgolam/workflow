// DEV ONLY. Writes sample Excel lookup files to docs/samples/lookups/ and, with --import, loads them into the
// organisation exactly as the Lookups page would (same parser, same checks).
//   npm run sample:lookups            (just write the .xlsx files)
//   npm run sample:lookups -- --import
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { audit, systemActor } from '../audit/audit';
import { config } from '../config';
import { closePool } from '../db/pool';
import { tenantQuery, withTx } from '../db/query';
import { checkKeyColumn, parseWorkbook, saveRows } from '../lookups/service';
import { resolveTenantId } from '../tenant';

const SAMPLES: { file: string; name: string; key: string; rows: string[][] }[] = [
  {
    file: 'schools.xlsx', name: 'Schools', key: 'School',
    rows: [
      ['School', 'Department', 'Secretary', 'Email'],
      ['Hawes Elementary', 'Elementary', 'Pat Lee', 'pat.lee@example.org'],
      ['Orchard Elementary', 'Elementary', 'Sam Roy', 'sam.roy@example.org'],
      ['Ridge Elementary', 'Elementary', 'Ana Cruz', 'ana.cruz@example.org'],
      ['Somerville Elementary', 'Elementary', 'Lin Wu', 'lin.wu@example.org'],
      ['Travell Elementary', 'Elementary', 'Joe Hart', 'joe.hart@example.org'],
      ['Benjamin Franklin Middle School', 'Middle School', 'Dana Kim', 'dana.kim@example.org'],
      ['George Washington Middle School', 'Middle School', 'Omar Aziz', 'omar.aziz@example.org'],
      ['High School', 'High School', 'Rita Bell', 'rita.bell@example.org'],
    ],
  },
  {
    file: 'departments.xlsx', name: 'Departments', key: 'Department',
    rows: [['Department', 'Department Code'], ['Administration', 'ADM-100'], ['Custodial', 'CUS-200'], ['Food Services', 'FDS-300'], ['Special Education', 'SPE-400'], ['Transportation', 'TRN-500']],
  },
  {
    file: 'job-descriptions.xlsx', name: 'Job descriptions', key: 'Job Description',
    rows: [['Job Description', 'Account'], ['Substitute Teacher', '1100-210'], ['Teaching Assistant', '1100-220'], ['Custodian', '2600-310'], ['Bus Driver', '2700-410'], ['Cafeteria Aide', '3100-510']],
  },
];

async function main() {
  if (config.isProd) throw new Error('sample:lookups is disabled in production');
  const dir = path.resolve(__dirname, '../../../docs/samples/lookups');
  fs.mkdirSync(dir, { recursive: true });
  const doImport = process.argv.includes('--import');
  const tenantId = doImport ? await resolveTenantId(null) : 0;
  const [admin] = doImport
    ? await tenantQuery<{ UserId: number }>(tenantId, `SELECT TOP 1 u.UserId FROM Users u JOIN UserRoles r ON r.TenantId = u.TenantId AND r.UserId = u.UserId AND r.Role = 'Admin' WHERE u.TenantId = @TenantId ORDER BY u.UserId`)
    : [];

  for (const s of SAMPLES) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(s.name);
    s.rows.forEach((r) => ws.addRow(r));
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => (c.width = 30));
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    fs.writeFileSync(path.join(dir, s.file), buffer);
    console.log(`wrote docs/samples/lookups/${s.file}`);

    if (!doImport) continue;
    const exists = await tenantQuery(tenantId, 'SELECT 1 AS x FROM LookupTables WHERE TenantId = @TenantId AND Name = @N', { N: s.name });
    if (exists.length) { console.log(`  "${s.name}" already imported - skipped`); continue; }
    const sheet = await parseWorkbook(buffer);
    checkKeyColumn(sheet, s.key);
    await withTx(async (tx) => {
      const [{ LookupId }] = await tenantQuery<{ LookupId: number }>(
        tenantId,
        `INSERT INTO LookupTables (TenantId, Name, KeyColumn, ColumnsJson, [RowCount], SourceFileName, CreatedBy)
         OUTPUT inserted.LookupId VALUES (@TenantId, @N, @K, @C, @R, @F, @By)`,
        { N: s.name, K: s.key, C: JSON.stringify(sheet.columns), R: sheet.rows.length, F: s.file, By: admin.UserId },
        tx,
      );
      await saveRows(tenantId, LookupId, sheet, s.key, tx);
      await audit(tenantId, systemActor, { action: 'lookup.imported', entityType: 'Lookup', entityId: LookupId, detail: { name: s.name, rows: sheet.rows.length, via: 'sample:lookups' } }, tx);
    });
    console.log(`  imported "${s.name}" (${sheet.rows.length} rows, key: ${s.key})`);
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
