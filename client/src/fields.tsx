// Shared by the submission form, the approver's section and the form builder's live preview:
// all three are driven by the same server-side field definitions.
import { useState, type ReactNode } from 'react';
import { FormulaError, evalFormula, evalValue, formulaRefs, formulaText, parseFormula, roundTo, type FormulaValue } from './formula';
import { SignatureImage, SignaturePad, parseSignature } from './sigpad';

export const INPUT_TYPES = [
  'text', 'textarea', 'email', 'tel', 'url', 'number', 'currency', 'range', 'date', 'time', 'datetime', 'month', 'week',
  'select', 'radio', 'multiselect', 'checkbox', 'lookup', 'color', 'signature', 'sigpad', 'grid',
] as const;
export const STATIC_TYPES = ['heading', 'paragraph', 'divider', 'image'] as const;
export type FieldType = (typeof INPUT_TYPES)[number] | (typeof STATIC_TYPES)[number];
export const isStatic = (t: string) => (STATIC_TYPES as readonly string[]).includes(t);
/** Everything can be resized on the grid except a divider, which always runs the full width. */
export const hasWidth = (t: string) => t !== 'divider';
export const isChoice = (t: string) => t === 'select' || t === 'radio' || t === 'multiselect';

export const WIDTHS = [3, 4, 6, 8, 9, 12] as const;
export type Width = (typeof WIDTHS)[number];

export const GRID_COLUMN_TYPES = ['text', 'number', 'currency', 'date', 'time', 'select', 'calc'] as const;
export type GridColumnType = (typeof GRID_COLUMN_TYPES)[number];
/** One column of a data grid. 'calc' columns are worked out from `formula`; people type into the others. */
export interface GridColumn { key: string; label: string; type: GridColumnType; required?: boolean; options?: string[]; formula?: string; decimals?: number; total?: boolean }
export type GridRow = Record<string, string>;
/** What the server stores for a grid: its own column headings, the rows (calculated cells included) and the totals. */
export interface GridValue { columns: { key: string; label: string; type: GridColumnType }[]; rows: Record<string, string | null>[]; totals: Record<string, string> }
export const isNumericColumn = (t: string) => t === 'number' || t === 'currency' || t === 'calc';
/** Columns a formula can read directly. A time reads as hours since midnight (17:30 is 17.5). */
export const isFormulaInput = (t: string) => t === 'number' || t === 'currency' || t === 'time';

export interface FieldRules { min?: number; max?: number; minLength?: number; maxLength?: number; pattern?: string }
export interface FieldProps {
  width?: Width; rows?: number; placeholder?: string; helpText?: string; defaultValue?: string; text?: string; step?: number; inline?: boolean;
  lookupId?: number; // 'lookup' control: the imported Excel table that supplies its choices
  lookupFrom?: string; // auto-filled control: key of the lookup control it follows...
  lookupColumn?: string; // ...and which column of that table it shows
  columns?: GridColumn[]; // 'grid' control
  minRows?: number;
  maxRows?: number;
  /** Heading / paragraph / picture: where it sits. Controls people type into: how the typed text lines up. */
  align?: Align;
  imageDataUrl?: string; // 'image' control: the picture, as a data: URL
  imageAlt?: string; // ...what a screen reader says instead
  imageHeight?: number; // ...its largest height in pixels
  headingSize?: HeadingSize; // 'heading' control: how big it is (medium when absent)
  /** No longer used or shown. Only here so the designer can drop it from forms saved while it existed. */
  formatExample?: string;
  /** Number, currency or text control worked out from other controls: read-only on the form, worked out again by the server. */
  formula?: string;
  decimals?: number; // ...places a calculated number is rounded to (currency is always 2; default 2)
}
export const HEADING_SIZES = ['small', 'medium', 'large', 'xlarge'] as const;
export type HeadingSize = (typeof HEADING_SIZES)[number];
export const ALIGNS = ['left', 'center', 'right', 'justify'] as const;
export type Align = (typeof ALIGNS)[number];
/** Controls whose typed text can be aligned. Only a long-text box can also be justified. */
export const TEXT_ALIGN_TYPES: string[] = ['text', 'textarea', 'email', 'tel', 'url', 'number', 'currency', 'signature'];
/** Which alignments a control offers: all four for text on the page, no "justified" for a picture or a one-line box. */
export function alignsFor(type: string): Align[] {
  if (type === 'heading' || type === 'paragraph' || type === 'textarea') return [...ALIGNS];
  if (type === 'image' || TEXT_ALIGN_TYPES.includes(type)) return ['left', 'center', 'right'];
  return [];
}
/** Sent with a form's fields: for each lookup table used, its keys and only the columns the form auto-fills from. */
export type Lookups = Record<number, { rows: { key: string; data: Record<string, string> }[] }>;
export const AUTOFILL_TYPES: string[] = ['text', 'textarea', 'email', 'tel', 'url', 'number', 'currency'];
export const isAutoFilled = (d: { props?: FieldProps | null }) => !!d.props?.lookupFrom;
export const CALC_TYPES: string[] = ['number', 'currency', 'text'];
/** Controls whose value a formula cannot read: they hold a drawing, a list or a table rather than one value. */
const NOT_READABLE = ['grid', 'sigpad', 'multiselect'];
export const isCalculated = (d: { type: string; props?: FieldProps | null }) => CALC_TYPES.includes(d.type) && !!d.props?.formula;
export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[] | null;
  rules: FieldRules | null;
  props?: FieldProps | null;
}
export interface FieldValue { key: string; label: string; type: string; value: string | null }
export type Value = string | boolean | string[] | GridRow[];
export type Values = Record<string, Value>;

/** Gives every lookup control its list of choices (the table's key values). */
export const withLookupOptions = (defs: FieldDef[], lookups: Lookups | undefined): FieldDef[] =>
  defs.map((d) => (d.type === 'lookup' ? { ...d, options: (lookups?.[d.props?.lookupId ?? 0]?.rows ?? []).map((r) => r.key) } : d));

/**
 * Fills the auto-filled controls from the row chosen in their lookup control. This is a preview for the
 * person filling in the form - the server works the values out again itself when the form is submitted.
 */
export function applyLookups(defs: FieldDef[], values: Values, lookups: Lookups | undefined): Values {
  let out = values;
  for (const d of defs) {
    if (!d.props?.lookupFrom) continue;
    const source = defs.find((x) => x.key === d.props!.lookupFrom);
    const chosen = values[source?.key ?? ''];
    const row = typeof chosen === 'string' ? lookups?.[source?.props?.lookupId ?? 0]?.rows.find((r) => r.key === chosen) : undefined;
    const next = row?.data[d.props.lookupColumn ?? ''] ?? '';
    if ((values[d.key] ?? '') !== next) out = { ...out, [d.key]: next };
  }
  return applyCalculations(defs, out);
}

// ---- calculated controls: the same rules as server/src/forms/validation.ts (calculatedValues) ----

/** What a formula on these controls may name: every control that holds one value, and grid.column for a data grid's number columns. */
export function formulaNames(defs: { key: string; type: string; props?: FieldProps | null }[]): string[] {
  const out: string[] = [];
  for (const d of defs) {
    if (!isStatic(d.type) && !NOT_READABLE.includes(d.type)) out.push(d.key);
    if (d.type === 'grid') for (const c of d.props?.columns ?? []) if (isNumericColumn(c.type)) out.push(`${d.key}.${c.key}`);
  }
  return out;
}

/** Calculated controls, each after everything its formula reads. Throws FormulaError on a loop or a broken formula. */
function calcOrder(defs: FieldDef[]): FieldDef[] {
  const calc = new Map(defs.filter(isCalculated).map((d) => [d.key, d]));
  const done = new Set<string>(), visiting = new Set<string>(), order: FieldDef[] = [];
  const visit = (d: FieldDef, path: string[]) => {
    if (done.has(d.key)) return;
    if (visiting.has(d.key)) throw new FormulaError(`${[...path, d.key].join(' -> ')} go round in a circle`);
    visiting.add(d.key);
    for (const ref of formulaRefs(parseFormula(d.props!.formula!))) { const dep = calc.get(ref); if (dep) visit(dep, [...path, d.key]); }
    visiting.delete(d.key);
    done.add(d.key);
    order.push(d);
  };
  for (const d of calc.values()) visit(d, []);
  return order;
}

/** Why these controls' formulas can't be saved, phrased for the person building the form - or null. */
export function formulaProblem(defs: FieldDef[]): string | null {
  const names = new Set(formulaNames(defs));
  for (const d of defs.filter(isCalculated)) {
    const name = d.label.trim() || d.key;
    try {
      const refs = [...formulaRefs(parseFormula(d.props!.formula!))];
      if (refs.includes(d.key)) return `"${name}": the formula uses the control itself.`;
      const bad = refs.find((r) => !names.has(r));
      if (bad) return `"${name}": the formula uses "${bad}", which is not the key of a control on this form that holds one value${bad.includes('.') ? ' (or of a number column of a data grid)' : ''}.`;
    } catch (err) {
      return `"${name}": the formula ${err instanceof FormulaError ? err.message : 'cannot be read'}.`;
    }
  }
  try { calcOrder(defs); } catch (err) { if (err instanceof FormulaError) return `The formulas of ${err.message}.`; }
  return null;
}

/** What a control's current value stands for in a formula: a number for numeric controls, text otherwise, null when empty. */
function valueIn(d: FieldDef, v: Value | undefined, column?: string): FormulaValue {
  if (d.type === 'checkbox') return v === true ? 1 : 0;
  if (d.type === 'grid' && column) {
    const cols = d.props?.columns ?? [];
    const col = cols.find((c) => c.key === column);
    const cells = (Array.isArray(v) ? (v as GridRow[]) : []).map((r) => (col?.type === 'calc' ? gridCalc(cols, r)[column] : r[column]) ?? '').filter((x) => x.trim() !== '' && Number.isFinite(Number(x)));
    return cells.length ? cells.reduce((sum, x) => sum + Number(x), 0) : null;
  }
  if (typeof v !== 'string' || v.trim() === '') return null;
  if (d.type === 'time') return /^\d{2}:\d{2}/.test(v) ? Number(v.slice(0, 2)) + Number(v.slice(3, 5)) / 60 : null;
  if (!['number', 'currency', 'range'].includes(d.type)) return v;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

/** Works out every calculated control from the others - the live preview; the server's result is what is stored. */
export function applyCalculations(defs: FieldDef[], values: Values): Values {
  let order: FieldDef[];
  try { order = calcOrder(defs); } catch { return values; } // the builder reports broken formulas
  let out = values;
  for (const d of order) {
    const ast = parseFormula(d.props!.formula!);
    const vars: Record<string, FormulaValue> = {};
    let timeMissing = false;
    for (const ref of formulaRefs(ast)) {
      const [key, column] = ref.split('.');
      const src = defs.find((x) => x.key === key);
      vars[ref] = src ? valueIn(src, out[key], column) : null;
      if (vars[ref] === null && src?.type === 'time') timeMissing = true;
    }
    let next: string;
    if (d.type === 'text') {
      const v = timeMissing ? null : evalValue(ast, vars);
      next = v === null ? '' : formulaText(v).slice(0, d.rules?.maxLength ?? 500);
    } else {
      const n = timeMissing ? null : evalFormula(ast, vars);
      const places = d.type === 'currency' ? 2 : d.props?.decimals ?? 2;
      next = n === null ? '' : roundTo(n, places).toFixed(places);
    }
    if ((out[d.key] ?? '') !== next) out = { ...out, [d.key]: next };
  }
  return out;
}

/** Starting values for a blank form, from each control's "default value". */
export function initialValues(defs: FieldDef[]): Values {
  const out: Values = {};
  for (const d of defs) {
    if (d.type === 'sigpad') continue; // nobody's signature is filled in for them
    if (d.type === 'grid') { out[d.key] = Array.from({ length: Math.max(1, d.props?.minRows ?? 1) }, () => ({})); continue; }
    const dv = d.props?.defaultValue?.trim();
    if (!dv || isStatic(d.type) || isCalculated(d)) continue;
    if (d.type === 'checkbox') out[d.key] = /^(true|yes|1|on)$/i.test(dv);
    else if (d.type === 'multiselect') out[d.key] = dv.split(',').map((s) => s.trim()).filter((s) => (d.options ?? []).includes(s));
    else if (isChoice(d.type)) { if ((d.options ?? []).includes(dv)) out[d.key] = dv; }
    else out[d.key] = dv;
  }
  return out;
}

/** Converts UI state to the API payload: layout elements and blanks are omitted, numbers are sent as numbers. */
export function toPayload(defs: FieldDef[], values: Values): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    if (isStatic(d.type) || isAutoFilled(d) || isCalculated(d)) continue; // auto-filled and calculated values are worked out by the server
    const v = values[d.key];
    if (d.type === 'grid') {
      // calculated cells are never sent: the server works them out. Rows left completely empty are dropped.
      const cols = (d.props?.columns ?? []).filter((c) => c.type !== 'calc');
      const rows = (Array.isArray(v) ? (v as GridRow[]) : [])
        .map((r) => Object.fromEntries(cols.filter((c) => (r[c.key] ?? '').trim() !== '').map((c) => [c.key, c.type === 'number' || c.type === 'currency' ? Number(r[c.key]) : r[c.key]])))
        .filter((r) => Object.keys(r).length > 0);
      if (rows.length) out[d.key] = rows;
      continue;
    }
    if (d.type === 'sigpad') { const sig = typeof v === 'string' ? parseSignature(v) : null; if (sig) out[d.key] = { strokes: sig.strokes }; continue; }
    if (d.type === 'checkbox') out[d.key] = v === true;
    else if (d.type === 'multiselect') { if (Array.isArray(v) && v.length) out[d.key] = v; }
    else if (typeof v === 'string' && v.trim() !== '') out[d.key] = d.type === 'number' || d.type === 'currency' || d.type === 'range' ? Number(v) : v;
  }
  return out;
}

/** Live preview of a row's calculated cells, left to right so a formula can use a calculated column before it. */
export function gridCalc(cols: GridColumn[], row: GridRow): Record<string, string> {
  const nums: Record<string, number | null> = {};
  for (const c of cols) {
    const text = (row[c.key] ?? '').trim();
    if (c.type === 'number' || c.type === 'currency') nums[c.key] = text === '' || !Number.isFinite(Number(text)) ? null : Number(text);
    else if (c.type === 'time') nums[c.key] = /^\d{2}:\d{2}/.test(text) ? Number(text.slice(0, 2)) + Number(text.slice(3, 5)) / 60 : null;
  }
  const out: Record<string, string> = {};
  for (const c of cols) {
    if (c.type !== 'calc') continue;
    let n: number | null = null;
    try {
      const ast = parseFormula(c.formula ?? '');
      // a missing time cannot stand in as 0 (midnight): the cell stays empty until both times are there
      const timeMissing = [...formulaRefs(ast)].some((ref) => nums[ref] == null && cols.some((x) => x.key === ref && x.type === 'time'));
      n = timeMissing ? null : evalFormula(ast, nums);
    } catch { /* the builder reports broken formulas */ }
    nums[c.key] = n === null ? null : roundTo(n, c.decimals ?? 2);
    out[c.key] = n === null ? '' : roundTo(n, c.decimals ?? 2).toFixed(c.decimals ?? 2);
  }
  return out;
}

const fmtNumber = (text: string | null | undefined, type: string, decimals?: number) => {
  if (text === null || text === undefined || text === '' || !Number.isFinite(Number(text))) return text ?? '';
  const places = type === 'currency' ? 2 : type === 'calc' ? decimals ?? (text.split('.')[1]?.length ?? 0) : undefined;
  return Number(text).toLocaleString(undefined, places === undefined ? { maximumFractionDigits: 6 } : { minimumFractionDigits: places, maximumFractionDigits: places });
};

/** A data grid being filled in: one table row per entry, calculated cells and totals updating as the person types. */
function GridInput({ def, value, error, disabled, onChange }: { def: FieldDef; value: Value | undefined; error?: string; disabled?: boolean; onChange(v: Value): void }) {
  const p = def.props ?? {};
  const cols = p.columns ?? [];
  const id = `f-${def.key}`;
  const min = Math.max(1, p.minRows ?? 1), max = p.maxRows ?? 200;
  const rows: GridRow[] = Array.isArray(value) && value.length ? (value as GridRow[]) : Array.from({ length: min }, () => ({}));
  const calc = rows.map((r) => gridCalc(cols, r));
  const setCell = (i: number, key: string, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
  const totalOf = (c: GridColumn) => rows.reduce((sum, r, i) => sum + (Number(c.type === 'calc' ? calc[i][c.key] : r[c.key]) || 0), 0);
  const hasTotals = cols.some((c) => c.total && isNumericColumn(c.type));
  return (
    <fieldset className="field gridf" disabled={disabled} aria-invalid={!!error} aria-describedby={[error ? `${id}-err` : '', p.helpText ? `${id}-help` : ''].filter(Boolean).join(' ') || undefined}>
      <legend>{def.label}{def.required && <em className="req"> *</em>}</legend>
      <div className="gridf-scroll">
        <table className="gridf-table">
          <thead>
            <tr>
              <th className="gridf-n" scope="col"><span className="sr-only">Row</span>#</th>
              {cols.map((c) => <th key={c.key} scope="col" className={isNumericColumn(c.type) ? 'num' : undefined}>{c.label}{c.required && <em className="req"> *</em>}</th>)}
              <th className="gridf-x"><span className="sr-only">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="gridf-n">{i + 1}</td>
                {cols.map((c) => {
                  const label = `${c.label}, row ${i + 1}`;
                  return (
                    <td key={c.key} className={isNumericColumn(c.type) ? 'num' : undefined}>
                      {c.type === 'calc' ? <output aria-label={label}>{fmtNumber(calc[i][c.key], 'calc', c.decimals ?? 2) || '—'}</output>
                        : c.type === 'select' ? (
                          <select aria-label={label} value={r[c.key] ?? ''} onChange={(e) => setCell(i, c.key, e.target.value)}>
                            <option value="">Select…</option>
                            {(c.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        ) : (
                          <input aria-label={label} autoComplete="off" value={r[c.key] ?? ''} onChange={(e) => setCell(i, c.key, e.target.value)}
                            type={c.type === 'text' ? 'text' : c.type === 'date' ? 'date' : c.type === 'time' ? 'time' : 'number'} step={c.type === 'currency' ? 0.01 : c.type === 'number' ? 'any' : undefined} maxLength={c.type === 'text' ? 500 : undefined} />
                        )}
                    </td>
                  );
                })}
                <td className="gridf-x">
                  <button type="button" className="link" disabled={rows.length <= min} onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove row ${i + 1}`} title="Remove this row">✕</button>
                </td>
              </tr>
            ))}
          </tbody>
          {hasTotals && (
            <tfoot>
              <tr>
                <th className="gridf-n" />
                {cols.map((c, i) => <td key={c.key} className={isNumericColumn(c.type) ? 'num' : undefined}>{c.total && isNumericColumn(c.type) ? <output aria-label={`Total ${c.label}`}>{fmtNumber(String(roundTo(totalOf(c), 6)), c.type, c.decimals ?? 2)}</output> : i === 0 ? 'Total' : ''}</td>)}
                <td className="gridf-x" />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <div className="gridf-foot">
        <button type="button" disabled={rows.length >= max} onClick={() => onChange([...rows, {}])}>+ Add row</button>
        {rows.length >= max && <span className="muted small">This table takes at most {max} rows.</span>}
      </div>
      {p.helpText && <p className="hint" id={`${id}-help`}>{p.helpText}</p>}
      {error && <p className="field-error" id={`${id}-err`}>{error}</p>}
    </fieldset>
  );
}

/** Read-only table for a stored grid value. */
export function GridTable({ value }: { value: string }) {
  let g: GridValue;
  try {
    g = JSON.parse(value) as GridValue;
    if (!Array.isArray(g.columns) || !Array.isArray(g.rows)) throw new Error('not a grid');
  } catch { return <>{value}</>; }
  const totals = g.totals ?? {};
  return (
    <div className="gridf-scroll">
      <table className="gridf-table read">
        <thead><tr>{g.columns.map((c) => <th key={c.key} scope="col" className={isNumericColumn(c.type) ? 'num' : undefined}>{c.label}</th>)}</tr></thead>
        <tbody>{g.rows.map((r, i) => <tr key={i}>{g.columns.map((c) => <td key={c.key} className={isNumericColumn(c.type) ? 'num' : undefined}>{isNumericColumn(c.type) ? fmtNumber(r[c.key], c.type) : c.type === 'date' && r[c.key] ? formatValue({ key: c.key, label: c.label, type: 'date', value: r[c.key] }) : r[c.key] ?? ''}</td>)}</tr>)}</tbody>
        {Object.keys(totals).length > 0 && <tfoot><tr>{g.columns.map((c, i) => <td key={c.key} className={isNumericColumn(c.type) ? 'num' : undefined}>{totals[c.key] !== undefined ? fmtNumber(totals[c.key], c.type) : i === 0 ? 'Total' : ''}</td>)}</tr></tfoot>}
      </table>
    </div>
  );
}

/** Boxes whose typed value is checked as soon as the person leaves the box. */
const CHECKED_AS_TYPED: string[] = ['text', 'textarea', 'email', 'tel', 'url', 'signature'];
const DEFAULT_MAX: Record<string, number> = { text: 500, textarea: 4000, email: 320, signature: 200, tel: 40, url: 2000 };

/**
 * The same format, length and pattern checks the server makes when the form is submitted (server/src/forms/validation.ts),
 * worded the same way, so a box can say what is wrong the moment it is left. An empty box is not flagged here: "required"
 * is checked on submit. The server always checks again - this is only a convenience.
 */
export function typedValueProblem(def: FieldDef, raw: string): string | null {
  const s = raw.trim();
  if (!s || !CHECKED_AS_TYPED.includes(def.type)) return null;
  if (def.type === 'tel' && !/^[+]?[\d\s().-]{3,40}$/.test(s)) return 'must be a phone number';
  if (def.type === 'url') {
    let u: URL | null = null;
    try { u = new URL(s); } catch { /* not a web address */ }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return 'must be a web address starting with http:// or https://';
  }
  if (def.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return 'must be an email address';
  const rules = def.rules ?? {};
  const max = rules.maxLength ?? DEFAULT_MAX[def.type] ?? 500;
  if (s.length > max) return `must be at most ${max} characters`;
  if (rules.minLength !== undefined && s.length < rules.minLength) return `must be at least ${rules.minLength} characters`;
  if (rules.pattern) {
    try {
      if (!new RegExp(rules.pattern).test(s)) return 'is not in the expected format';
    } catch { /* an unreadable pattern is refused when the form is saved */ }
  }
  return null;
}

const HTML_TYPE: Partial<Record<FieldType, string>> = {
  text: 'text', email: 'email', tel: 'tel', url: 'url', number: 'number', currency: 'number', date: 'date', time: 'time',
  datetime: 'datetime-local', month: 'month', week: 'week', signature: 'text',
};

export function FieldInput(props: { def: FieldDef; value: Value | undefined; error?: string; disabled?: boolean; onChange(v: Value): void }) {
  const { def, value, disabled, onChange } = props;
  const p = def.props ?? {};
  const id = `f-${def.key}`;
  // once the person has left a box, its typed value is checked as they go on typing, so the message clears as soon as it is right
  const [left, setLeft] = useState(false);
  const checkAsTyped = CHECKED_AS_TYPED.includes(def.type) && !isAutoFilled(def) && !isCalculated(def) && !disabled;
  const error = props.error ?? (left && checkAsTyped && typeof value === 'string' ? typedValueProblem(def, value) ?? undefined : undefined);
  const describedBy = [error ? `${id}-err` : '', p.helpText ? `${id}-help` : ''].filter(Boolean).join(' ') || undefined;
  const common = { id, disabled, 'aria-invalid': !!error, 'aria-describedby': describedBy, onBlur: checkAsTyped ? () => setLeft(true) : undefined };
  const text = typeof value === 'string' ? value : '';
  const req = def.required && <em className="req"> *</em>;
  const notes = (
    <>
      {p.helpText && <p className="hint" id={`${id}-help`}>{p.helpText}</p>}
      {error && <p className="field-error" id={`${id}-err`}>{error}</p>}
    </>
  );

  // ---- layout elements ----
  const align = p.align && alignsFor(def.type).includes(p.align) ? p.align : undefined;
  if (def.type === 'heading') return <h3 className={`f-heading f-heading-${p.headingSize ?? 'medium'}`} style={{ textAlign: align }}>{def.label}</h3>;
  if (def.type === 'paragraph') return <p className="f-paragraph" style={{ textAlign: align }}>{p.text || def.label}</p>;
  if (def.type === 'divider') return <hr className="f-divider" />;
  if (def.type === 'image') {
    return (
      <div className="f-image" style={{ textAlign: align ?? 'left' }}>
        {p.imageDataUrl
          ? <img src={p.imageDataUrl} alt={p.imageAlt ?? ''} style={{ maxHeight: p.imageHeight ?? 120 }} />
          : <span className="muted small">No picture chosen yet</span>}
      </div>
    );
  }
  if (def.type === 'grid') return <GridInput {...props} />;

  if (def.type === 'checkbox') {
    return (
      <div className="field">
        <label className="check">
          <input type="checkbox" {...common} checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span>{def.label}{req}</span>
        </label>
        {notes}
      </div>
    );
  }

  if (def.type === 'radio' || def.type === 'multiselect') {
    const picked = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="field choice" disabled={disabled} aria-invalid={!!error} aria-describedby={describedBy}>
        <legend>{def.label}{req}</legend>
        <div className={p.inline ? 'choice-list inline' : 'choice-list'}>
          {(def.options ?? []).map((o) => (
            <label key={o} className="check plain">
              {def.type === 'radio' ? (
                <input type="radio" name={id} checked={value === o} onChange={() => onChange(o)} />
              ) : (
                <input type="checkbox" checked={picked.includes(o)} onChange={(e) => onChange(e.target.checked ? [...picked, o] : picked.filter((x) => x !== o))} />
              )}
              <span>{o}</span>
            </label>
          ))}
        </div>
        {notes}
      </fieldset>
    );
  }

  let control: ReactNode;
  if (def.type === 'sigpad') {
    control = <SignaturePad id={id} label={def.label} value={text} disabled={disabled} invalid={!!error} describedBy={describedBy} onChange={onChange} />;
  } else if (def.type === 'textarea') {
    control = <textarea {...common} rows={p.rows ?? 4} placeholder={p.placeholder} maxLength={def.rules?.maxLength} value={text} style={{ textAlign: align }} onChange={(e) => onChange(e.target.value)} />;
  } else if (def.type === 'lookup' && (def.options?.length ?? 0) > 60) {
    control = (
      <>
        <input {...common} list={`${id}-list`} placeholder={p.placeholder || 'Start typing to search…'} autoComplete="off" value={text}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => { const hit = (def.options ?? []).find((o) => o.toLowerCase() === e.target.value.trim().toLowerCase()); onChange(hit ?? ''); }} />
        <datalist id={`${id}-list`}>{(def.options ?? []).map((o) => <option key={o} value={o} />)}</datalist>
      </>
    );
  } else if (def.type === 'select' || def.type === 'lookup') {
    control = (
      <select {...common} value={text} onChange={(e) => onChange(e.target.value)}>
        <option value="">{p.placeholder || 'Select…'}</option>
        {(def.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  } else if (def.type === 'range') {
    const min = def.rules?.min ?? 0, max = def.rules?.max ?? 100;
    control = (
      <div className="range">
        <input {...common} type="range" min={min} max={max} step={p.step ?? 1} value={text === '' ? String(min) : text} onChange={(e) => onChange(e.target.value)} />
        <output htmlFor={id}>{text === '' ? '—' : text}</output>
      </div>
    );
  } else if (def.type === 'color') {
    control = (
      <div className="color">
        <input {...common} type="color" value={text || '#000000'} onChange={(e) => onChange(e.target.value)} />
        <span className="muted small">{text || 'Not chosen'}</span>
        {text && !disabled && <button type="button" className="link" onClick={() => onChange('')}>clear</button>}
      </div>
    );
  } else {
    control = (
      <input
        {...common}
        type={HTML_TYPE[def.type] ?? 'text'}
        step={def.type === 'currency' ? p.step ?? 0.01 : def.type === 'number' ? p.step ?? 'any' : undefined}
        min={def.type === 'number' || def.type === 'currency' ? def.rules?.min : undefined}
        max={def.type === 'number' || def.type === 'currency' ? def.rules?.max : undefined}
        maxLength={def.rules?.maxLength}
        className={def.type === 'signature' ? 'signature' : undefined}
        placeholder={p.placeholder ?? (def.type === 'signature' ? 'Type your full name' : def.type === 'url' ? 'https://' : undefined)}
        autoComplete="off"
        value={text}
        style={align ? { textAlign: align } : undefined}
        readOnly={isAutoFilled(def) || isCalculated(def)}
        tabIndex={isAutoFilled(def) || isCalculated(def) ? -1 : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (isAutoFilled(def) && def.type === 'textarea') control = <textarea {...common} rows={p.rows ?? 3} value={text} style={{ textAlign: align }} readOnly tabIndex={-1} />;
  return (
    <div className={isCalculated(def) ? 'field calculated' : isAutoFilled(def) ? 'field autofilled' : 'field'}>
      <label htmlFor={id}>{def.label}{req}</label>
      {control}
      {notes}
    </div>
  );
}

/** Lays controls out on the 12-column grid using each control's width; collapses to one column on small screens. */
export function FieldGrid(props: { defs: FieldDef[]; children(def: FieldDef, index: number): ReactNode }) {
  return (
    <div className="fgrid">
      {props.defs.map((d, i) => (
        <div key={d.key || i} className="fcell" style={{ gridColumn: `span ${hasWidth(d.type) ? d.props?.width ?? 12 : 12}` }}>{props.children(d, i)}</div>
      ))}
    </div>
  );
}

export function formatValue(f: FieldValue): string {
  if (f.value === null || f.value === '') return '—';
  if (f.type === 'checkbox') return f.value === 'true' ? 'Yes' : 'No';
  if (f.type === 'currency') return Number(f.value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (f.type === 'date') return new Date(`${f.value}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
  if (f.type === 'datetime') return new Date(f.value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  if (f.type === 'month') return new Date(`${f.value}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  if (f.type === 'week') return f.value.replace(/^(\d{4})-W(\d{2})$/, 'Week $2, $1');
  if (f.type === 'multiselect') {
    try { return (JSON.parse(f.value) as string[]).join(', ') || '—'; } catch { return f.value; }
  }
  if (f.type === 'sigpad') return 'Signed';
  if (f.type === 'grid') {
    try { const n = (JSON.parse(f.value) as GridValue).rows.length; return `${n} row${n === 1 ? '' : 's'}`; } catch { return f.value; }
  }
  return f.value;
}

/** Read-only rendering of stored values. */
export function ValueList({ items }: { items: FieldValue[] }) {
  if (items.length === 0) return <p className="muted">No fields.</p>;
  return (
    <dl className="values">
      {items.map((f) => (
        <div key={f.key} className={f.type === 'grid' && f.value ? 'wide' : undefined}>
          <dt>{f.label}</dt>
          <dd className={f.type === 'signature' ? 'signature' : f.type === 'textarea' ? 'pre' : undefined}>
            {f.type === 'grid' && f.value ? <GridTable value={f.value} />
              : f.type === 'sigpad' && f.value ? <SignatureImage value={f.value} label={`${f.label} (drawn signature)`} />
              : f.type === 'color' && f.value ? <><span className="swatch" style={{ background: /^#[0-9a-f]{6}$/i.test(f.value) ? f.value : undefined }} /> {f.value}</>
              : f.type === 'url' && f.value && /^https?:\/\//i.test(f.value) ? <a href={f.value} target="_blank" rel="noopener noreferrer">{f.value}</a>
              : formatValue(f)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export const fmtDateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

export function StatusBadge({ status }: { status: string }) {
  const label = status === 'InProgress' ? 'In progress' : status === 'NotReached' ? 'Not reached' : status;
  return <span className={`badge badge-${status.toLowerCase()}`}>{label}</span>;
}
