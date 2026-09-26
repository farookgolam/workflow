import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom, audit } from '../audit/audit';
import { tenantQuery, withTx, type Tx } from '../db/query';
import { AppError } from '../http/errors';
import { idParam } from '../workflow/routes';
import { LIMITS, checkKeyColumn, columnsInUse, lookupUsage, parseWorkbook, saveRows } from './service';

// Mounted at /admin/lookups, behind requireAuth + requireRole('Admin').
// The spreadsheet travels as the raw request body (application/octet-stream); its name and the chosen
// key column are query parameters. JSON bodies are capped at 1 MB app-wide, this route allows 5 MB.
export const adminLookupsRouter = Router();
const rawFile = express.raw({ type: ['application/octet-stream', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], limit: LIMITS.bytes });
const fileOf = (req: Request): Buffer => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new AppError(400, 'empty_file', 'No file was received.');
  return req.body;
};
const importQuery = z.object({
  name: z.string().trim().min(1).max(200),
  keyColumn: z.string().trim().min(1).max(100),
  fileName: z.string().trim().max(260).optional(),
});

adminLookupsRouter.get('/', async (req, res) => {
  const { tenantId } = req.user!;
  const rows = await tenantQuery<Record<string, any>>(
    tenantId,
    'SELECT LookupId, Name, KeyColumn, ColumnsJson, [RowCount] AS Rows, SourceFileName, UpdatedAt FROM LookupTables WHERE TenantId = @TenantId ORDER BY Name',
  );
  res.json({
    lookups: await Promise.all(rows.map(async (t) => ({
      lookupId: t.LookupId, name: t.Name, keyColumn: t.KeyColumn, columns: JSON.parse(t.ColumnsJson) as string[], rows: t.Rows,
      sourceFileName: t.SourceFileName, updatedAt: t.UpdatedAt, usedBy: await lookupUsage(tenantId, t.LookupId),
    }))),
  });
});

/** The first 100 rows, or with ?q= the first 100 whose key or any other cell contains that text. */
adminLookupsRouter.get('/:id', async (req, res) => {
  const { tenantId } = req.user!;
  const id = idParam(req.params.id);
  const q = z.string().trim().max(200).optional().parse(req.query.q) || null;
  const [t] = await tenantQuery<Record<string, any>>(tenantId, 'SELECT Name, KeyColumn, ColumnsJson, [RowCount] AS Rows FROM LookupTables WHERE TenantId = @TenantId AND LookupId = @L', { L: id });
  if (!t) throw new AppError(404, 'not_found', 'Lookup table not found');
  // LIKE wildcards in what was typed are matched literally
  const like = q ? `%${q.replace(/[[%_]/g, (c) => `[${c}]`)}%` : null;
  const where = 'TenantId = @TenantId AND LookupId = @L AND (@Q IS NULL OR KeyValue LIKE @Q OR DataJson LIKE @Q)';
  const sample = await tenantQuery<{ LookupRowId: number; KeyValue: string; DataJson: string }>(
    tenantId, `SELECT TOP 100 LookupRowId, KeyValue, DataJson FROM LookupRows WHERE ${where} ORDER BY SortOrder`, { L: id, Q: like });
  const [{ n }] = q ? await tenantQuery<{ n: number }>(tenantId, `SELECT COUNT(*) AS n FROM LookupRows WHERE ${where}`, { L: id, Q: like }) : [{ n: t.Rows }];
  res.json({
    lookupId: id, name: t.Name, keyColumn: t.KeyColumn, columns: JSON.parse(t.ColumnsJson), rows: t.Rows, matches: n,
    sample: sample.map((r) => ({ [t.KeyColumn]: r.KeyValue, ...JSON.parse(r.DataJson) })),
    rowIds: sample.map((r) => r.LookupRowId), // the same order as sample: what edit and delete address a row by
  });
});

/** Step 1: read the file and show what is in it. Nothing is saved. */
adminLookupsRouter.post('/parse', rawFile, async (req, res) => {
  const sheet = await parseWorkbook(fileOf(req));
  res.json({ sheetName: sheet.sheetName, columns: sheet.columns, rowCount: sheet.rows.length, sample: sheet.rows.slice(0, 8), warnings: sheet.warnings });
});

/** Step 2: the same file again, now with a name and the key column chosen. */
adminLookupsRouter.post('/import', rawFile, async (req, res) => {
  const q = importQuery.parse(req.query);
  const { tenantId, userId } = req.user!;
  const sheet = await parseWorkbook(fileOf(req));
  checkKeyColumn(sheet, q.keyColumn);

  const lookupId = await withTx(async (tx) => {
    const clash = await tenantQuery(tenantId, 'SELECT 1 AS x FROM LookupTables WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND Name = @Name', { Name: q.name }, tx);
    if (clash.length) throw new AppError(409, 'name_taken', 'A lookup table with this name already exists. Use "Replace data" on it, or choose another name.');
    const [{ LookupId }] = await tenantQuery<{ LookupId: number }>(
      tenantId,
      `INSERT INTO LookupTables (TenantId, Name, KeyColumn, ColumnsJson, [RowCount], SourceFileName, CreatedBy)
       OUTPUT inserted.LookupId VALUES (@TenantId, @Name, @Key, @Cols, @Rows, @File, @By)`,
      { Name: q.name, Key: q.keyColumn, Cols: JSON.stringify(sheet.columns), Rows: sheet.rows.length, File: q.fileName ?? null, By: userId },
      tx,
    );
    await saveRows(tenantId, LookupId, sheet, q.keyColumn, tx);
    await audit(tenantId, actorFrom(req), { action: 'lookup.imported', entityType: 'Lookup', entityId: LookupId, detail: { name: q.name, keyColumn: q.keyColumn, columns: sheet.columns, rows: sheet.rows.length, file: q.fileName } }, tx);
    return LookupId;
  });
  res.status(201).json({ lookupId, rows: sheet.rows.length, warnings: sheet.warnings });
});

/** Replace the data with a newer spreadsheet. Columns that forms rely on must still be there. */
adminLookupsRouter.put('/:id/import', rawFile, async (req, res) => {
  const { tenantId } = req.user!;
  const id = idParam(req.params.id);
  const fileName = z.string().trim().max(260).optional().parse(req.query.fileName);
  const sheet = await parseWorkbook(fileOf(req));

  await withTx(async (tx) => {
    const [t] = await tenantQuery<{ KeyColumn: string; Name: string }>(tenantId, 'SELECT KeyColumn, Name FROM LookupTables WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND LookupId = @L', { L: id }, tx);
    if (!t) throw new AppError(404, 'not_found', 'Lookup table not found');
    checkKeyColumn(sheet, t.KeyColumn);

    const missing = (await columnsInUse(tenantId, id, tx)).filter((c) => !sheet.columns.includes(c));
    if (missing.length) throw new AppError(409, 'columns_in_use', `Forms still use column(s) that are missing from this file: ${missing.join(', ')}. Keep those column headings, or change the forms first.`);

    await tenantQuery(
      tenantId,
      'UPDATE LookupTables SET ColumnsJson = @Cols, [RowCount] = @Rows, SourceFileName = COALESCE(@File, SourceFileName), UpdatedAt = SYSUTCDATETIME() WHERE TenantId = @TenantId AND LookupId = @L',
      { L: id, Cols: JSON.stringify(sheet.columns), Rows: sheet.rows.length, File: fileName ?? null },
      tx,
    );
    await saveRows(tenantId, id, sheet, t.KeyColumn, tx);
    await audit(tenantId, actorFrom(req), { action: 'lookup.replaced', entityType: 'Lookup', entityId: id, detail: { name: t.Name, columns: sheet.columns, rows: sheet.rows.length, file: fileName } }, tx);
  });
  res.json({ rows: sheet.rows.length, warnings: sheet.warnings });
});

// Rows edited by hand follow the import's rules: the key is required and unique (ignoring capitals), cells are trimmed.
const rowBody = z.object({ values: z.record(z.string(), z.string().max(LIMITS.cell, `A cell can be at most ${LIMITS.cell} characters`)) });

interface TableRow { Name: string; KeyColumn: string; ColumnsJson: string; Rows: number }
const lockTable = async (tenantId: number, id: number, tx: Tx): Promise<TableRow> => {
  const [t] = await tenantQuery<TableRow>(
    tenantId,
    'SELECT Name, KeyColumn, ColumnsJson, [RowCount] AS Rows FROM LookupTables WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND LookupId = @L',
    { L: id },
    tx,
  );
  if (!t) throw new AppError(404, 'not_found', 'Lookup table not found');
  return t;
};

/** A row as typed in: every column present and trimmed, the key filled in, short enough and not used by another row. */
async function cleanRow(tenantId: number, id: number, t: TableRow, values: Record<string, string>, tx: Tx, exceptRowId?: number) {
  const columns: string[] = JSON.parse(t.ColumnsJson);
  const unknown = Object.keys(values).filter((c) => !columns.includes(c));
  if (unknown.length) throw new AppError(400, 'unknown_column', `This table has no column called ${unknown.map((c) => `"${c}"`).join(', ')}.`);
  const clean = Object.fromEntries(columns.map((c) => [c, (values[c] ?? '').trim()]));
  const key = clean[t.KeyColumn];
  if (!key) throw new AppError(400, 'blank_key', `Fill in "${t.KeyColumn}" - it is what people choose on the form.`);
  if (key.length > 400) throw new AppError(400, 'key_too_long', 'Key values can be at most 400 characters.');
  const [taken] = await tenantQuery<{ KeyValue: string }>(
    tenantId,
    'SELECT KeyValue FROM LookupRows WHERE TenantId = @TenantId AND LookupId = @L AND KeyValue = @K AND (@Except IS NULL OR LookupRowId <> @Except)',
    { L: id, K: key, Except: exceptRowId ?? null },
    tx,
  );
  if (taken) throw new AppError(409, 'duplicate_key', `"${taken.KeyValue}" is already in this table. Every row needs a different ${t.KeyColumn}.`);
  const { [t.KeyColumn]: _key, ...rest } = clean;
  return { clean, key, rest };
}

const lockRow = async (tenantId: number, id: number, rowId: number, keyColumn: string, tx: Tx): Promise<Record<string, string>> => {
  const [r] = await tenantQuery<{ KeyValue: string; DataJson: string }>(
    tenantId,
    'SELECT KeyValue, DataJson FROM LookupRows WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND LookupId = @L AND LookupRowId = @R',
    { L: id, R: rowId },
    tx,
  );
  if (!r) throw new AppError(404, 'not_found', 'That row is no longer in this table');
  return { [keyColumn]: r.KeyValue, ...JSON.parse(r.DataJson) };
};

/** Add one row by hand, without a new spreadsheet, at the end of the table (at most LIMITS.rows rows). Forms offer it straight away. */
adminLookupsRouter.post('/:id/rows', async (req, res) => {
  const { tenantId } = req.user!;
  const id = idParam(req.params.id);
  const { values } = rowBody.parse(req.body);

  const row = await withTx(async (tx) => {
    const t = await lockTable(tenantId, id, tx);
    if (t.Rows >= LIMITS.rows) throw new AppError(409, 'too_many_rows', `A lookup table can hold at most ${LIMITS.rows} rows.`);
    const { clean, key, rest } = await cleanRow(tenantId, id, t, values, tx);

    await tenantQuery(
      tenantId,
      `INSERT INTO LookupRows (TenantId, LookupId, KeyValue, DataJson, SortOrder)
       SELECT @TenantId, @L, @K, @D, COALESCE(MAX(SortOrder), 0) + 1 FROM LookupRows WHERE TenantId = @TenantId AND LookupId = @L`,
      { L: id, K: key, D: JSON.stringify(rest) },
      tx,
    );
    await tenantQuery(tenantId, 'UPDATE LookupTables SET [RowCount] = [RowCount] + 1, UpdatedAt = SYSUTCDATETIME() WHERE TenantId = @TenantId AND LookupId = @L', { L: id }, tx);
    await audit(tenantId, actorFrom(req), { action: 'lookup.row_added', entityType: 'Lookup', entityId: id, detail: { name: t.Name, row: clean } }, tx);
    return clean;
  });
  res.status(201).json({ row });
});

/** Change one row; it keeps its place. Requests already submitted keep the values they stored; forms offer the new values from now on. */
adminLookupsRouter.put('/:id/rows/:rowId', async (req, res) => {
  const { tenantId } = req.user!;
  const id = idParam(req.params.id);
  const rowId = idParam(req.params.rowId);
  const { values } = rowBody.parse(req.body);

  const row = await withTx(async (tx) => {
    const t = await lockTable(tenantId, id, tx);
    const before = await lockRow(tenantId, id, rowId, t.KeyColumn, tx);
    const { clean, key, rest } = await cleanRow(tenantId, id, t, values, tx, rowId);
    await tenantQuery(tenantId, 'UPDATE LookupRows SET KeyValue = @K, DataJson = @D WHERE TenantId = @TenantId AND LookupId = @L AND LookupRowId = @R', { L: id, R: rowId, K: key, D: JSON.stringify(rest) }, tx);
    await tenantQuery(tenantId, 'UPDATE LookupTables SET UpdatedAt = SYSUTCDATETIME() WHERE TenantId = @TenantId AND LookupId = @L', { L: id }, tx);
    await audit(tenantId, actorFrom(req), { action: 'lookup.row_updated', entityType: 'Lookup', entityId: id, detail: { name: t.Name, before, after: clean } }, tx);
    return clean;
  });
  res.json({ row });
});

/** Remove one row. Requests already submitted keep the values they stored; forms stop offering it. */
adminLookupsRouter.delete('/:id/rows/:rowId', async (req, res) => {
  const { tenantId } = req.user!;
  const id = idParam(req.params.id);
  const rowId = idParam(req.params.rowId);

  await withTx(async (tx) => {
    const t = await lockTable(tenantId, id, tx);
    const row = await lockRow(tenantId, id, rowId, t.KeyColumn, tx);
    await tenantQuery(tenantId, 'DELETE FROM LookupRows WHERE TenantId = @TenantId AND LookupId = @L AND LookupRowId = @R', { L: id, R: rowId }, tx);
    await tenantQuery(tenantId, 'UPDATE LookupTables SET [RowCount] = [RowCount] - 1, UpdatedAt = SYSUTCDATETIME() WHERE TenantId = @TenantId AND LookupId = @L', { L: id }, tx);
    await audit(tenantId, actorFrom(req), { action: 'lookup.row_deleted', entityType: 'Lookup', entityId: id, detail: { name: t.Name, row } }, tx);
  });
  res.status(204).end();
});

adminLookupsRouter.delete('/:id', async (req, res) => {
  const { tenantId } = req.user!;
  const id = idParam(req.params.id);
  await withTx(async (tx) => {
    const [t] = await tenantQuery<{ Name: string }>(tenantId, 'SELECT Name FROM LookupTables WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @TenantId AND LookupId = @L', { L: id }, tx);
    if (!t) throw new AppError(404, 'not_found', 'Lookup table not found');
    const usedBy = await lookupUsage(tenantId, id, tx);
    if (usedBy.length) throw new AppError(409, 'in_use', `This lookup is used by: ${usedBy.join(', ')}. Remove the lookup control from those forms first.`);
    await tenantQuery(tenantId, 'DELETE FROM LookupRows WHERE TenantId = @TenantId AND LookupId = @L', { L: id }, tx);
    await tenantQuery(tenantId, 'DELETE FROM LookupTables WHERE TenantId = @TenantId AND LookupId = @L', { L: id }, tx);
    await audit(tenantId, actorFrom(req), { action: 'lookup.deleted', entityType: 'Lookup', entityId: id, detail: { name: t.Name } }, tx);
  });
  res.status(204).end();
});
