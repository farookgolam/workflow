import { z } from 'zod';
import { AppError } from '../http/errors';
import { checkSignature } from './sigpad';
import { FORMULA_MAX, FormulaError, evalFormula, evalValue, formulaRefs, formulaText, parseFormula, roundTo, type FormulaValue } from './formula';

/** Controls that collect a value. */
export const INPUT_TYPES = [
  'text', 'textarea', 'number', 'currency', 'date', 'select', 'checkbox', 'email', 'signature',
  'tel', 'url', 'time', 'datetime', 'month', 'week', 'color', 'range', 'radio', 'multiselect', 'lookup', 'grid', 'sigpad',
] as const;
/** Layout elements: shown on the form, never submitted or stored. */
export const STATIC_TYPES = ['heading', 'paragraph', 'divider', 'image'] as const;
export const FIELD_TYPES = [...INPUT_TYPES, ...STATIC_TYPES] as const;
export const FORM_FIELD_TYPES = FIELD_TYPES;
export type FieldType = (typeof FIELD_TYPES)[number];

export const isStatic = (t: string): boolean => (STATIC_TYPES as readonly string[]).includes(t);
const CHOICE_TYPES = ['select', 'radio', 'multiselect'];

export interface FieldRules {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

export const GRID_COLUMN_TYPES = ['text', 'number', 'currency', 'date', 'time', 'select', 'calc'] as const;
export const GRID_MAX_ROWS = 200;
/** One column of a 'grid' control. 'calc' columns are worked out from `formula`; people type into the others. */
export interface GridColumn {
  key: string;
  label: string;
  type: (typeof GRID_COLUMN_TYPES)[number];
  required?: boolean;
  options?: string[]; // 'select'
  formula?: string; // 'calc': arithmetic over the keys of number / currency / time columns and of calc columns to its left
  decimals?: number; // 'calc': places the result is rounded to (default 2)
  total?: boolean; // number / currency / calc: show and store the column's sum
}

/** Presentation only - nothing in here affects what is accepted, except `step` for number-like inputs and the grid settings. */
export interface FieldProps {
  width?: 3 | 4 | 6 | 8 | 9 | 12; // columns of a 12-column grid
  rows?: number; // text-area height
  placeholder?: string;
  helpText?: string;
  defaultValue?: string;
  text?: string; // body of a paragraph element
  step?: number;
  inline?: boolean; // radio / multi-choice options side by side
  lookupId?: number; // 'lookup' control: which imported table supplies the choices
  lookupFrom?: string; // auto-filled control: key of the lookup control it follows...
  lookupColumn?: string; // ...and the column of that table it shows
  columns?: GridColumn[]; // 'grid' control
  minRows?: number;
  maxRows?: number;
  /** Heading / paragraph / picture: where it sits. Controls people type into: how the typed text lines up. */
  align?: Align;
  imageDataUrl?: string; // 'image' control: the picture, as a data: URL (PNG, JPEG, GIF or WebP - never SVG)
  imageAlt?: string; // ...what a screen reader says instead
  imageHeight?: number; // ...its largest height in pixels (it is also never wider than its space)
  headingSize?: HeadingSize; // 'heading' control: how big it is (medium when absent)
  formatExample?: string; // no longer used or shown; still accepted so a form saved while it existed can be saved again
  /** Number, currency or text control worked out from other controls (see calculatedValues): read-only on the form. */
  formula?: string;
  decimals?: number; // ...places a calculated number is rounded to (currency is always 2; default 2)
}

export const HEADING_SIZES = ['small', 'medium', 'large', 'xlarge'] as const;
export type HeadingSize = (typeof HEADING_SIZES)[number];

export const ALIGNS = ['left', 'center', 'right', 'justify'] as const;
export type Align = (typeof ALIGNS)[number];
/** A 300 KB picture is about 400,000 characters once base64-encoded. */
export const IMAGE_MAX_CHARS = 400_000;
// SVG is left out on purpose: it can carry script, and these pictures are shown to everyone who opens the form.
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** The spreadsheet row each lookup control's submitted key resolved to (null = not found). Built by lookups/service. */
export type ResolvedLookups = Map<string, { key: string; data: Record<string, string> } | null>;

export interface FieldDef {
  id: number;
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: string[] | null;
  rules: FieldRules | null;
  props: FieldProps | null;
  sortOrder: number;
}

const DEFAULT_MAX: Record<string, number> = { text: 500, textarea: 4000, email: 320, signature: 200, tel: 40, url: 2000 };
const FORMATS: Record<string, [RegExp, string]> = {
  time: [/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a time in HH:MM format'],
  datetime: [/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, 'must be a date and time (YYYY-MM-DDTHH:MM)'],
  month: [/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a month in YYYY-MM format'],
  week: [/^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/, 'must be a week in YYYY-Www format'],
  color: [/^#[0-9a-fA-F]{6}$/, 'must be a colour such as #1d4ed8'],
  tel: [/^[+]?[\d\s().-]{3,40}$/, 'must be a phone number'],
};
const realDate = (ymd: string) => !Number.isNaN(Date.parse(`${ymd}T00:00:00Z`)) && new Date(`${ymd}T00:00:00Z`).toISOString().slice(0, 10) === ymd;

/** Length and pattern rules, for every control that offers them in the designer (text, email, phone, web address, typed signature...). */
function textRuleError(def: FieldDef, s: string): string | null {
  const rules = def.rules ?? {};
  const max = rules.maxLength ?? DEFAULT_MAX[def.type] ?? 500;
  if (s.length > max) return `must be at most ${max} characters`;
  if (rules.minLength !== undefined && s.length < rules.minLength) return `must be at least ${rules.minLength} characters`;
  if (rules.pattern && !new RegExp(rules.pattern).test(s)) return 'is not in the expected format';
  return null;
}

function checkOne(def: FieldDef, raw: unknown): { value: string | null } | { error: string } {
  const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0);
  if (def.type === 'checkbox') {
    if (empty) return { value: 'false' };
    if (typeof raw !== 'boolean') return { error: 'must be true or false' };
    return { value: String(raw) };
  }
  if (empty) return { value: null };

  const rules = def.rules ?? {};
  switch (def.type) {
    case 'number':
    case 'currency':
    case 'range': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return { error: 'must be a number' };
      const min = rules.min ?? (def.type === 'range' ? 0 : undefined);
      const max = rules.max ?? (def.type === 'range' ? 100 : undefined);
      if (min !== undefined && n < min) return { error: `must be at least ${min}` };
      if (max !== undefined && n > max) return { error: `must be at most ${max}` };
      return { value: def.type === 'currency' ? n.toFixed(2) : String(n) };
    }
    case 'date': {
      if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !realDate(raw)) return { error: 'must be a real date in YYYY-MM-DD format' };
      return { value: raw };
    }
    case 'time':
    case 'datetime':
    case 'month':
    case 'week':
    case 'color':
    case 'tel': {
      const [re, message] = FORMATS[def.type];
      if (typeof raw !== 'string' || !re.test(raw.trim())) return { error: message };
      if (def.type === 'datetime' && !realDate(raw.slice(0, 10))) return { error: 'is not a real calendar date' };
      if (def.type === 'tel') {
        const problem = textRuleError(def, raw.trim());
        if (problem) return { error: problem };
      }
      return { value: def.type === 'color' ? raw.trim().toLowerCase() : raw.trim() };
    }
    case 'url': {
      if (typeof raw !== 'string' || raw.length > DEFAULT_MAX.url) return { error: 'must be a web address' };
      let u: URL;
      try {
        u = new URL(raw.trim());
      } catch {
        return { error: 'must be a web address starting with http:// or https://' };
      }
      // links are shown to approvers: never accept javascript:, data:, file: ...
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'must be a web address starting with http:// or https://' };
      const problem = textRuleError(def, raw.trim());
      if (problem) return { error: problem };
      return { value: u.toString() };
    }
    case 'select':
    case 'radio': {
      if (typeof raw !== 'string' || !(def.options ?? []).includes(raw)) return { error: 'is not one of the allowed options' };
      return { value: raw };
    }
    case 'sigpad':
      return checkSignature(raw);
    case 'multiselect': {
      if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) return { error: 'must be a list of options' };
      const allowed = def.options ?? [];
      const picked = [...new Set(raw as string[])];
      if (picked.some((v) => !allowed.includes(v))) return { error: 'contains an option that is not allowed' };
      if (rules.min !== undefined && picked.length < rules.min) return { error: `needs at least ${rules.min} selected` };
      if (rules.max !== undefined && picked.length > rules.max) return { error: `allows at most ${rules.max} selected` };
      return { value: JSON.stringify(allowed.filter((o) => picked.includes(o))) }; // stored in the form's option order
    }
    default: {
      if (typeof raw !== 'string') return { error: 'must be text' };
      const s = raw.trim();
      if (def.type === 'email' && !z.string().email().safeParse(s).success) return { error: 'must be an email address' };
      const problem = textRuleError(def, s);
      if (problem) return { error: problem };
      return { value: s };
    }
  }
}

/** What is stored for a grid: a self-describing snapshot, so read-only views and the PDF need nothing but the value. */
export interface GridValue {
  columns: { key: string; label: string; type: GridColumn['type'] }[];
  rows: Record<string, string | null>[];
  totals: Record<string, string>;
}

const numText = (n: number) => String(Number(n.toFixed(6)));
/** HH:MM as hours since midnight - what a formula sees for a time column. */
export const timeToHours = (hhmm: string) => Number(hhmm.slice(0, 2)) + Number(hhmm.slice(3, 5)) / 60;

/** Rows are checked cell by cell; calculated cells and totals are worked out here and anything the browser sent for them is ignored. */
function checkGrid(def: FieldDef, raw: unknown): { value: string | null } | { error: string } {
  const cols = def.props?.columns ?? [];
  if (!Array.isArray(raw) || raw.some((r) => typeof r !== 'object' || r === null || Array.isArray(r))) return { error: 'must be a list of rows' };
  const max = Math.min(def.props?.maxRows ?? GRID_MAX_ROWS, GRID_MAX_ROWS);
  if (raw.length > GRID_MAX_ROWS * 5) return { error: `allows at most ${max} rows` };

  const inputs = cols.filter((c) => c.type !== 'calc');
  const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  const rows: Record<string, string | null>[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (inputs.every((c) => blank(r[c.key]))) continue; // rows left empty are dropped, not stored
    const n = rows.length + 1;
    const stray = Object.keys(r).find((k) => !cols.some((c) => c.key === k));
    if (stray !== undefined) return { error: `row ${n}: "${stray.slice(0, 50)}" is not a column` };
    const out: Record<string, string | null> = {};
    const nums: Record<string, number | null> = {};
    for (const c of inputs) {
      // each cell follows the rules of the ordinary control of the same type
      const cell = checkOne({ ...def, label: c.label, type: c.type as FieldType, options: c.options ?? null, rules: null, props: null }, r[c.key]);
      if ('error' in cell) return { error: `row ${n}: ${c.label} ${cell.error}` };
      if (cell.value === null && c.required) return { error: `row ${n}: ${c.label} is required` };
      out[c.key] = cell.value;
      if (c.type === 'number' || c.type === 'currency') nums[c.key] = cell.value === null ? null : Number(cell.value);
      if (c.type === 'time') nums[c.key] = cell.value === null ? null : timeToHours(cell.value);
    }
    // left to right, so a formula can build on a calculated column before it
    for (const c of cols.filter((x) => x.type === 'calc')) {
      const ast = parseFormula(c.formula ?? '');
      // unlike a blank number, a missing time cannot stand in as 0 (midnight): the cell stays empty until both times are there
      const timeMissing = [...formulaRefs(ast)].some((ref) => nums[ref] == null && cols.some((x) => x.key === ref && x.type === 'time'));
      const result = timeMissing ? null : evalFormula(ast, nums);
      const rounded = result === null ? null : roundTo(result, c.decimals ?? 2);
      nums[c.key] = rounded;
      out[c.key] = rounded === null ? null : rounded.toFixed(c.decimals ?? 2);
    }
    rows.push(Object.fromEntries(cols.map((c) => [c.key, out[c.key]]))); // in column order
    if (rows.length > max) return { error: `allows at most ${max} rows` };
  }
  const min = def.props?.minRows ?? 0;
  if (rows.length === 0 && min === 0) return { value: null };
  if (rows.length < min && (rows.length > 0 || def.required)) return { error: `needs at least ${min} filled-in row${min === 1 ? '' : 's'}` };
  if (rows.length === 0) return { value: null };

  const totals: Record<string, string> = {};
  for (const c of cols) {
    if (!c.total || (c.type !== 'number' && c.type !== 'currency' && c.type !== 'calc')) continue;
    const sum = rows.reduce((acc, r) => acc + Number(r[c.key] ?? 0), 0);
    totals[c.key] = c.type === 'currency' ? roundTo(sum, 2).toFixed(2) : c.type === 'calc' ? roundTo(sum, c.decimals ?? 2).toFixed(c.decimals ?? 2) : numText(sum);
  }
  const value: GridValue = { columns: cols.map((c) => ({ key: c.key, label: c.label, type: c.type })), rows, totals };
  return { value: JSON.stringify(value) };
}

/**
 * Validates submitted values against field definitions (used for both form fields and
 * approver step fields). Unknown keys are rejected, layout elements are ignored. Returns
 * values normalised to strings in definition order, ready to be stored.
 */
export function validateValues(
  allDefs: FieldDef[],
  input: Record<string, unknown>,
  opts: { enforceRequired: boolean } = { enforceRequired: true },
  lookups: ResolvedLookups = new Map(),
): { def: FieldDef; value: string | null }[] {
  const defs = allDefs.filter((d) => !isStatic(d.type));
  const errors: { path: string; message: string }[] = [];
  const known = new Set(defs.map((d) => d.key));
  for (const key of Object.keys(input)) if (!known.has(key)) errors.push({ path: key, message: 'is not a field on this form' });

  const out: { def: FieldDef; value: string | null }[] = [];
  for (const def of defs) {
    // Auto-filled from a lookup: the value comes from the spreadsheet row, never from the browser.
    if (isCalculated(def)) {
      out.push({ def, value: null }); // filled in below, once everything it reads is known
      continue;
    }
    if (def.props?.lookupFrom) {
      const row = lookups.get(def.props.lookupFrom);
      const text = (row?.data[def.props.lookupColumn ?? ''] ?? '').slice(0, 4000);
      out.push({ def, value: text === '' ? null : text });
      continue;
    }
    if (def.type === 'lookup') {
      const raw = input[def.key];
      const empty = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
      const row = lookups.get(def.key);
      if (!empty && !row) { errors.push({ path: def.key, message: `${def.label} is not one of the available choices` }); continue; }
      if (empty && opts.enforceRequired && def.required) { errors.push({ path: def.key, message: `${def.label} is required` }); continue; }
      out.push({ def, value: row ? row.key : null });
      continue;
    }
    const result = def.type === 'grid' ? checkGrid(def, input[def.key] ?? []) : checkOne(def, input[def.key]);
    if ('error' in result) {
      errors.push({ path: def.key, message: `${def.label} ${result.error}` });
      continue;
    }
    const missing = result.value === null || (def.type === 'checkbox' && result.value === 'false');
    if (opts.enforceRequired && def.required && missing) {
      errors.push({ path: def.key, message: `${def.label} is required` });
      continue;
    }
    out.push({ def, value: result.value });
  }
  if (!errors.length) calculatedValues(defs, out, errors, opts.enforceRequired);
  if (errors.length) throw new AppError(400, 'validation_failed', 'Invalid input', errors);
  return out;
}

// ---- calculated controls ----
// A number, currency or text control with props.formula is worked out from other controls of the same form (or
// of the same approver section): any control that holds one value (a time counts as hours since midnight, a tick
// box as 1 or 0), other calculated controls, and the total of a data grid column written grid.column. The browser
// shows the result as people type; the server works it out again here and ignores whatever the browser sent.
export const CALC_TYPES: string[] = ['number', 'currency', 'text'];
/** Controls whose value a formula cannot read: they hold a drawing, a list or a table rather than one value. */
const NOT_READABLE = ['grid', 'sigpad', 'multiselect'];
const isCalculated = (d: { type: string; props?: FieldProps | null }) => CALC_TYPES.includes(d.type) && !!d.props?.formula;
type CalcSource = { key: string; type: string; props?: FieldProps | null };

/** What a formula on this list of controls may name. */
function formulaNames(fields: CalcSource[]): Set<string> {
  const names = new Set<string>();
  for (const f of fields) {
    if (!isStatic(f.type) && !NOT_READABLE.includes(f.type)) names.add(f.key);
    if (f.type === 'grid') for (const c of f.props?.columns ?? []) if (['number', 'currency', 'calc'].includes(c.type)) names.add(`${f.key}.${c.key}`);
  }
  return names;
}

/** Calculated controls in an order where everything a formula reads is worked out first. Throws on a loop. */
function calcOrder<T extends CalcSource>(fields: T[]): T[] {
  const calc = new Map(fields.filter(isCalculated).map((f) => [f.key, f]));
  const done = new Set<string>(), visiting = new Set<string>(), order: T[] = [];
  const visit = (f: T, path: string[]) => {
    if (done.has(f.key)) return;
    if (visiting.has(f.key)) throw new FormulaError(`${[...path, f.key].join(' -> ')} go round in a circle`);
    visiting.add(f.key);
    for (const ref of formulaRefs(parseFormula(f.props!.formula!))) {
      const dep = calc.get(ref);
      if (dep) visit(dep, [...path, f.key]);
    }
    visiting.delete(f.key);
    done.add(f.key);
    order.push(f);
  };
  for (const f of calc.values()) visit(f, []);
  return order;
}

/** Why the formulas of this list of controls can't be saved, or null. Checked when a form or a section is saved. */
export function formulaProblem(fields: CalcSource[]): string | null {
  const names = formulaNames(fields);
  for (const f of fields.filter(isCalculated)) {
    try {
      const refs = [...formulaRefs(parseFormula(f.props!.formula!))];
      const bad = refs.find((r) => !names.has(r));
      if (bad) return `the formula of "${f.key}" uses "${bad}", which is not the key of a control on this form that holds one value${bad.includes('.') ? ' (or of a number column of a data grid)' : ''}`;
      if (refs.includes(f.key)) return `the formula of "${f.key}" uses itself`;
    } catch (err) {
      if (err instanceof FormulaError) return `the formula of "${f.key}" ${err.message}`;
      throw err;
    }
  }
  try {
    calcOrder(fields);
  } catch (err) {
    if (err instanceof FormulaError) return `the formulas of ${err.message}`;
    throw err;
  }
  return null;
}

/** What a stored value stands for in a formula: a number for numeric controls, text otherwise, null when empty. */
function valueOf(def: FieldDef, value: string | null, column?: string): FormulaValue {
  if (def.type === 'checkbox') return value === 'true' ? 1 : 0;
  if (value === null || value === '') return null;
  if (def.type === 'grid' && column) {
    const grid = JSON.parse(value) as GridValue;
    const cells = grid.rows.map((r) => r[column]).filter((v): v is string => v !== null && v !== undefined && v !== '');
    return cells.length ? cells.reduce((sum, v) => sum + Number(v), 0) : null;
  }
  if (def.type === 'time') return /^\d{2}:\d{2}$/.test(value) ? timeToHours(value) : null;
  if (!['number', 'currency', 'range'].includes(def.type)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Works out the calculated controls from the values already checked, and applies their minimum / maximum. */
function calculatedValues(defs: FieldDef[], out: { def: FieldDef; value: string | null }[], errors: { path: string; message: string }[], enforceRequired: boolean): void {
  const byKey = new Map(out.map((o) => [o.def.key, o]));
  for (const def of calcOrder(defs)) {
    const ast = parseFormula(def.props!.formula!);
    const vars: Record<string, FormulaValue> = {};
    for (const ref of formulaRefs(ast)) {
      const [key, column] = ref.split('.');
      const src = byKey.get(key);
      vars[ref] = src ? valueOf(src.def, src.value, column) : null;
    }
    // an empty time cannot stand in as midnight: the result stays empty until the times are there
    const timeMissing = [...formulaRefs(ast)].some((r) => vars[r] === null && byKey.get(r)?.def.type === 'time');
    if (def.type === 'text') {
      const v = timeMissing ? null : evalValue(ast, vars);
      const text = v === null ? '' : formulaText(v).slice(0, def.rules?.maxLength ?? DEFAULT_MAX.text);
      byKey.get(def.key)!.value = text === '' ? null : text;
      if (text === '' && enforceRequired && def.required) errors.push({ path: def.key, message: `${def.label} is required` });
      continue;
    }
    const n = timeMissing ? null : evalFormula(ast, vars);
    const places = def.type === 'currency' ? 2 : def.props?.decimals ?? 2;
    const slot = byKey.get(def.key)!;
    slot.value = n === null ? null : roundTo(n, places).toFixed(places);
    const rules = def.rules ?? {};
    if (n !== null && rules.min !== undefined && roundTo(n, places) < rules.min) errors.push({ path: def.key, message: `${def.label} must be at least ${rules.min}` });
    else if (n !== null && rules.max !== undefined && roundTo(n, places) > rules.max) errors.push({ path: def.key, message: `${def.label} must be at most ${rules.max}` });
    else if (n === null && enforceRequired && def.required) errors.push({ path: def.key, message: `${def.label} is required` });
  }
}

// ---- schemas for admins defining fields ----
const rulesSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    minLength: z.number().int().min(0).optional(),
    maxLength: z.number().int().min(1).max(4000).optional(),
    pattern: z
      .string()
      .max(300)
      .refine((p) => {
        try {
          new RegExp(p);
          return true;
        } catch {
          return false;
        }
      }, 'invalid regular expression')
      .optional(),
  })
  .strict();

const gridColumnSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,99}$/),
    label: z.string().trim().min(1).max(100),
    type: z.enum(GRID_COLUMN_TYPES),
    required: z.boolean().optional(),
    options: z.array(z.string().trim().min(1).max(200)).min(1).max(200).optional(),
    formula: z.string().trim().min(1).max(300).optional(),
    decimals: z.number().int().min(0).max(6).optional(),
    total: z.boolean().optional(),
  })
  .strict();

/** Why a grid's columns cannot be used, or null. A formula may read number / currency / time columns and calc columns defined before it. */
export function gridColumnsProblem(cols: GridColumn[]): string | null {
  if (!uniqueKeys(cols)) return 'column keys must be different from each other';
  if (!cols.some((c) => c.type !== 'calc')) return 'needs at least one column that people fill in';
  const numeric = new Set(cols.filter((c) => c.type === 'number' || c.type === 'currency' || c.type === 'time').map((c) => c.key));
  for (const c of cols) {
    if (c.type === 'select' && !c.options?.length) return `column "${c.label}" needs at least one option`;
    if (c.type === 'select' && new Set(c.options).size !== c.options!.length) return `column "${c.label}": options must be different from each other`;
    if (c.type === 'calc') {
      if (!c.formula) return `column "${c.label}" needs a formula`;
      try {
        for (const ref of formulaRefs(parseFormula(c.formula))) {
          if (!numeric.has(ref)) return `column "${c.label}": the formula uses "${ref}", which is not a number, currency, time or earlier calculated column`;
        }
      } catch (err) {
        if (err instanceof FormulaError) return `column "${c.label}": the formula ${err.message}`;
        throw err;
      }
    }
    if (c.type === 'calc') numeric.add(c.key);
  }
  return null;
}

const propsSchema = z
  .object({
    width: z.union([z.literal(3), z.literal(4), z.literal(6), z.literal(8), z.literal(9), z.literal(12)]).optional(),
    rows: z.number().int().min(2).max(20).optional(),
    placeholder: z.string().max(200).optional(),
    helpText: z.string().max(500).optional(),
    defaultValue: z.string().max(500).optional(),
    text: z.string().max(2000).optional(),
    step: z.number().positive().optional(),
    inline: z.boolean().optional(),
    lookupId: z.number().int().positive().optional(),
    lookupFrom: z.string().regex(/^(form[.])?[a-z][a-zA-Z0-9_]{0,99}$/).optional(), // 'form.<key>': a step control following a lookup of the submission
    lookupColumn: z.string().min(1).max(100).optional(),
    columns: z.array(gridColumnSchema).min(1).max(12).optional(),
    minRows: z.number().int().min(0).max(GRID_MAX_ROWS).optional(),
    maxRows: z.number().int().min(1).max(GRID_MAX_ROWS).optional(),
    align: z.enum(ALIGNS).optional(),
    imageDataUrl: z.string().max(IMAGE_MAX_CHARS, 'the picture is too large - keep it under 300 KB').regex(IMAGE_DATA_URL, 'the picture must be a PNG, JPEG, GIF or WebP image').optional(),
    imageAlt: z.string().max(300).optional(),
    imageHeight: z.number().int().min(16).max(800).optional(),
    headingSize: z.enum(HEADING_SIZES).optional(),
    formatExample: z.string().max(100).optional(),
    formula: z.string().trim().min(1).max(FORMULA_MAX).optional(),
    decimals: z.number().int().min(0).max(6).optional(),
  })
  .strict();

export const fieldDefinitionSchema = <T extends readonly [string, ...string[]]>(types: T) =>
  z
    .object({
      key: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,99}$/, 'start with a lowercase letter; letters, digits and _ only'),
      label: z.string().trim().min(1).max(200),
      type: z.enum(types),
      required: z.boolean().default(false),
      options: z.array(z.string().trim().min(1).max(200)).min(1).max(200).optional(),
      rules: rulesSchema.optional(),
      props: propsSchema.optional(),
    })
    .refine((f) => !CHOICE_TYPES.includes(f.type) || (f.options?.length ?? 0) > 0, { message: 'this control needs at least one option', path: ['options'] })
    .refine((f) => !f.options || new Set(f.options).size === f.options.length, { message: 'options must be different from each other', path: ['options'] })
    .refine((f) => (f.type === 'grid') === !!f.props?.columns, { message: 'a data grid needs columns, and only a data grid can have them', path: ['props', 'columns'] })
    .refine((f) => (f.props?.minRows ?? 0) <= (f.props?.maxRows ?? GRID_MAX_ROWS), { message: 'the minimum number of rows is above the maximum', path: ['props', 'minRows'] })
    .refine((f) => !f.props?.formula || CALC_TYPES.includes(f.type), { message: 'only a number, currency or text control can be calculated', path: ['props', 'formula'] })
    .refine((f) => !(f.props?.formula && f.props?.lookupFrom), { message: 'a control is either calculated or auto-filled from a lookup, not both', path: ['props', 'formula'] })
    .refine((f) => (f.type === 'image') === !!f.props?.imageDataUrl, { message: 'a picture control needs a picture, and only a picture control can have one', path: ['props', 'imageDataUrl'] })
    .superRefine((f, ctx) => {
      const problem = f.type === 'grid' && f.props?.columns ? gridColumnsProblem(f.props.columns) : null;
      if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['props', 'columns'] });
    });

export function uniqueKeys(fields: { key: string }[]): boolean {
  return new Set(fields.map((f) => f.key)).size === fields.length;
}
