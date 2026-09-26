import type * as MsSql from 'mssql';
import { getPool, sql } from './pool';

export type Params = Record<string, string | number | boolean | Date | Buffer | null | undefined>;
export type Tx = MsSql.Transaction;

async function run<T>(text: string, params: Params, tx?: Tx): Promise<MsSql.IResult<T>> {
  const request = tx ? new sql.Request(tx) : (await getPool()).request();
  for (const [name, value] of Object.entries(params)) request.input(name, value ?? null);
  const result = await request.query<T>(text);
  for (const recordset of (result.recordsets as MsSql.IRecordSet<Record<string, unknown>>[]) ?? []) {
    normalizeIntegers(recordset);
  }
  return result;
}

/**
 * The ODBC driver hands back IDENTITY columns (reported as "int identity", which mssql does
 * not map) and BIGINTs as strings, while tedious returns numbers for the former. Normalise
 * both to numbers so ids behave the same under either driver. Our ids stay far below 2^53.
 */
function normalizeIntegers(recordset: MsSql.IRecordSet<Record<string, unknown>>): void {
  const columns = Object.entries(recordset.columns ?? {})
    .filter(([, col]) => {
      const type = (col as { type?: unknown }).type;
      return type === undefined || type === sql.BigInt;
    })
    .map(([name]) => name);
  if (columns.length === 0) return;
  for (const row of recordset) {
    for (const name of columns) {
      const value = row[name];
      if (typeof value === 'string' && /^-?\d{1,15}$/.test(value)) row[name] = Number(value);
    }
  }
}

/**
 * The ONLY way application code should touch tenant data. The tenant id is always bound
 * as @TenantId and the statement is rejected if it never references it, so a query that
 * forgets its tenant filter fails loudly in development instead of leaking rows.
 */
export async function tenantQuery<T = Record<string, unknown>>(
  tenantId: number,
  text: string,
  params: Params = {},
  tx?: Tx,
): Promise<T[]> {
  if (!Number.isInteger(tenantId) || tenantId <= 0) throw new Error('tenantQuery: invalid tenantId');
  if (!/@TenantId\b/.test(text)) throw new Error('tenantQuery: statement does not reference @TenantId');
  if ('TenantId' in params) throw new Error('tenantQuery: TenantId is bound automatically');
  const result = await run<T>(text, { ...params, TenantId: tenantId }, tx);
  return result.recordset ?? [];
}

/**
 * For the few lookups that happen before a tenant is known (tenant by slug, token by hash)
 * and for system workers. Every call site is deliberate - grep for this name in review.
 */
export async function unscopedQuery<T = Record<string, unknown>>(
  text: string,
  params: Params = {},
  tx?: Tx,
): Promise<T[]> {
  const result = await run<T>(text, params, tx);
  return result.recordset ?? [];
}

const DEADLOCK_VICTIM = 1205;

/** Runs fn in a transaction. If SQL Server picks it as a deadlock victim, the whole unit is re-run (up to 3 tries). */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await runTx(fn);
    } catch (err) {
      if ((err as { number?: number }).number !== DEADLOCK_VICTIM || attempt >= 3) throw err;
    }
  }
}

async function runTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = new sql.Transaction(await getPool());
  await tx.begin();
  try {
    const out = await fn(tx);
    await tx.commit();
    return out;
  } catch (err) {
    try {
      await tx.rollback();
    } catch {
      // already rolled back by the server (e.g. THROW inside a trigger)
    }
    throw err;
  }
}
