// Reports show dates as MM/DD/YYYY, and a date with a time as MM/DD/YYYY h:mm AM/PM - the same as their CSV and
// Excel exports (server/src/reports/dates.ts).

/** 2026-09-23 -> 09/23/2026. Anything else is returned unchanged. */
export function usDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}

/** An instant as 09/23/2026 2:05 PM, in this computer's time zone. */
export function usDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getMonth() + 1)}/${two(d.getDate())}/${d.getFullYear()} ${d.getHours() % 12 || 12}:${two(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}

/** Sent with an export so dates with a time come out in the reader's time zone. */
export const myTimeZone = (): string | undefined => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } };

/** How long ago, in words a person would say: "less than an hour", "5 hours", "3 days". */
export function waitedFor(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const ms = now - new Date(iso).getTime();
  if (!(ms >= 0)) return '';
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return 'less than an hour';
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
