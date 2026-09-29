// The submitted values, as label/value rows for an approval email, so an approver can see what they are deciding
// on before they open the page. A customer can turn this off (TenantSettings.EmailShowDetails) if its forms carry
// things that should not travel by email.
import { tenantQuery, type Tx } from '../db/query';
import { usDate } from '../reports/dates';
import { effectiveSettings } from '../settings/service';

const MAX_ROWS = 12;
const MAX_CHARS = 200;

/** Stored text -> what a person reads. Signatures and grids are summarised rather than dumped. */
export function emailValue(type: string, value: string | null): string | null {
  if (value === null || value === '') return null;
  const cut = (s: string) => (s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS - 1)}…` : s);
  switch (type) {
    case 'checkbox':
      return value === 'true' ? 'Yes' : 'No';
    case 'date':
      return usDate(value);
    case 'datetime':
      return usDate(value.replace('T', ' '));
    case 'sigpad':
      return 'Signed';
    case 'multiselect':
      try { return cut((JSON.parse(value) as string[]).join(', ')) || null; } catch { return cut(value); }
    case 'grid':
      try {
        const n = (JSON.parse(value) as { rows: unknown[] }).rows.length;
        return `${n} row${n === 1 ? '' : 's'} (open the request to see them)`;
      } catch { return null; }
    default:
      return cut(value);
  }
}

export async function submissionDetails(tenantId: number, requestId: number, tx: Tx): Promise<{ label: string; value: string }[]> {
  if (!(await effectiveSettings(tenantId)).mail.showDetails) return [];
  const rows = await tenantQuery<{ FieldLabel: string; FieldType: string; Value: string | null }>(
    tenantId,
    'SELECT FieldLabel, FieldType, Value FROM RequestData WHERE TenantId = @TenantId AND RequestId = @RequestId ORDER BY SortOrder',
    { RequestId: requestId },
    tx,
  );
  const out: { label: string; value: string }[] = [];
  for (const r of rows) {
    const value = emailValue(r.FieldType, r.Value);
    if (value !== null) out.push({ label: r.FieldLabel, value });
  }
  if (out.length > MAX_ROWS) {
    const more = out.length - MAX_ROWS + 1;
    return [...out.slice(0, MAX_ROWS - 1), { label: '…', value: `and ${more} more field${more === 1 ? '' : 's'} on the request page` }];
  }
  return out;
}
