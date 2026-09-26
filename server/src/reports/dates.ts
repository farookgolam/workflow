// How reports write dates: MM/DD/YYYY, and MM/DD/YYYY h:mm AM/PM for a date with a time. Reports keep ISO dates
// (2026-09-23) internally - that is what filters, sorting and grouping compare - and turn them into these only
// for people: on screen (the client does the same), in CSV and in Excel.

/** 2026-09-23 -> 09/23/2026. Anything else is returned unchanged. */
export function usDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}

/** A time zone the browser sent, if the server knows it; otherwise UTC. */
export function safeTimeZone(tz: string | undefined): string {
  if (!tz) return 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'UTC'; }
}

/** The wall-clock parts of an instant in a time zone. */
function parts(iso: string, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute) };
}

/** An instant (ISO) as 09/23/2026 2:05 PM in the reader's time zone. */
export function usDateTime(iso: string, timeZone: string): string {
  const { y, mo, d, h, mi } = parts(iso, timeZone);
  return `${String(mo).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y} ${h % 12 || 12}:${String(mi).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** For Excel: a Date whose UTC fields are the reader's wall-clock time (Excel has no time zones). */
export function excelDateTime(iso: string, timeZone: string): Date {
  const { y, mo, d, h, mi } = parts(iso, timeZone);
  return new Date(Date.UTC(y, mo - 1, d, h, mi));
}

export const EXCEL_DATE = 'mm/dd/yyyy';
export const EXCEL_DATETIME = 'mm/dd/yyyy h:mm AM/PM';

/** A grouping bucket as a label: day 09/23/2026, week "Week 39, 2026", month 09/2026, year 2026. */
export function periodLabel(key: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return usDate(key);
  const w = /^(\d{4})-W(\d{2})$/.exec(key);
  if (w) return `Week ${Number(w[2])}, ${w[1]}`;
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  return m ? `${m[2]}/${m[1]}` : key;
}
