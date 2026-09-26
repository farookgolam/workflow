// Formulas for calculated controls and calculated grid columns.
//   numbers and "quoted text", keys of other controls (grid.column for a data grid column's total),
//   + - * /   & (joins text)   = <> < > <= >= (give 1 or 0)   brackets, and the functions in FUNCTIONS below.
// A time reads as hours since midnight (17:30 is 17.5), so timeOut - timeIn is the hours between them.
// Parsed by hand into a small tree and evaluated by walking it - the text is never handed to eval() or Function().
// A copy of server/src/forms/formula.ts - keep the two the same. This one only drives the live preview; the server works the stored values out again.

export type Ast =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; name: string }
  | { t: 'neg'; a: Ast }
  | { t: 'bin'; op: BinOp; a: Ast; b: Ast }
  | { t: 'call'; fn: string; args: Ast[] };
type BinOp = '+' | '-' | '*' | '/' | '&' | '=' | '<>' | '<' | '>' | '<=' | '>=';

/** What a formula works with: a number, some text, or nothing (an empty control). */
export type FormulaValue = number | string | null;

export class FormulaError extends Error {}

export const FORMULA_MAX = 300;

/** A value as a number: empty is 0, text that is not a number is NaN (so the result ends up empty). */
const num = (v: FormulaValue): number => (v === null || v === '' ? 0 : typeof v === 'number' ? v : Number(v.trim()));
/** A value as text: empty is "", a number without float noise (0.1 + 0.2 shows as 0.3). */
const str = (v: FormulaValue): string => (v === null ? '' : typeof v === 'number' ? String(roundTo(v, 10)) : v);
export const formulaText = str;
const truthy = (v: FormulaValue): boolean => (typeof v === 'number' ? v !== 0 : v !== null && v !== '' && v !== '0' && v.toLowerCase() !== 'false');
/** YYYY-MM-DD (or the start of a date-and-time) as a day number, NaN otherwise. */
const dayOf = (v: FormulaValue): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v));
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000 : NaN;
};

interface Fn { min: number; max: number; help: string; run(a: FormulaValue[]): FormulaValue }
/** Every function a formula may call, by lower-case name. `help` is what the form builder lists. */
export const FUNCTIONS: Record<string, Fn> = {
  // numbers
  sum: { min: 1, max: 30, help: 'sum(a, b, ...) adds them up', run: (a) => a.reduce<number>((s, x) => s + num(x), 0) },
  average: { min: 1, max: 30, help: 'average(a, b, ...) of the ones filled in', run: (a) => { const f = a.filter((x) => x !== null && x !== ''); return f.length ? f.reduce<number>((s, x) => s + num(x), 0) / f.length : null; } },
  min: { min: 1, max: 30, help: 'min(a, b, ...) the smallest', run: (a) => Math.min(...a.map(num)) },
  max: { min: 1, max: 30, help: 'max(a, b, ...) the largest', run: (a) => Math.max(...a.map(num)) },
  round: { min: 1, max: 2, help: 'round(x, places)', run: ([x, n = 0]) => roundTo(num(x), Math.max(0, Math.min(6, Math.trunc(num(n))))) },
  floor: { min: 1, max: 1, help: 'floor(x) rounds down', run: ([x]) => Math.floor(num(x)) },
  ceiling: { min: 1, max: 1, help: 'ceiling(x) rounds up', run: ([x]) => Math.ceil(num(x)) },
  abs: { min: 1, max: 1, help: 'abs(x) without its sign', run: ([x]) => Math.abs(num(x)) },
  mod: { min: 2, max: 2, help: 'mod(a, b) the remainder of a / b', run: ([a, b]) => { const d = num(b); return d === 0 ? NaN : num(a) - d * Math.floor(num(a) / d); } },
  power: { min: 2, max: 2, help: 'power(x, n) x to the power n', run: ([x, n]) => num(x) ** num(n) },
  // hours from a start time to an end time; an end before the start is taken to be the next day (22:00 to 06:00 is 8)
  elapsed: { min: 2, max: 2, help: 'elapsed(start, end) hours between two times', run: ([s, e]) => (num(e) >= num(s) ? num(e) - num(s) : num(e) - num(s) + 24) },
  days: { min: 2, max: 2, help: 'days(from, to) days between two dates', run: ([f, t]) => dayOf(t) - dayOf(f) },
  // logic
  if: { min: 2, max: 3, help: 'if(condition, then, otherwise)', run: () => null }, // evaluated lazily below
  // text
  concat: { min: 1, max: 30, help: 'concat(a, b, ...) joins text (so does &)', run: (a) => a.map(str).join('') },
  substring: { min: 2, max: 3, help: 'substring(text, start, length) - start counts from 1', run: ([t, s, n]) => { const from = Math.max(1, Math.trunc(num(s))) - 1; return n === undefined ? str(t).slice(from) : str(t).slice(from, from + Math.max(0, Math.trunc(num(n)))); } },
  left: { min: 2, max: 2, help: 'left(text, n) the first n characters', run: ([t, n]) => str(t).slice(0, Math.max(0, Math.trunc(num(n)))) },
  right: { min: 2, max: 2, help: 'right(text, n) the last n characters', run: ([t, n]) => { const k = Math.max(0, Math.trunc(num(n))); return k === 0 ? '' : str(t).slice(-k); } },
  upper: { min: 1, max: 1, help: 'upper(text)', run: ([t]) => str(t).toUpperCase() },
  lower: { min: 1, max: 1, help: 'lower(text)', run: ([t]) => str(t).toLowerCase() },
  trim: { min: 1, max: 1, help: 'trim(text) without spaces at either end', run: ([t]) => str(t).trim().replace(/\s+/g, ' ') },
  len: { min: 1, max: 1, help: 'len(text) the number of characters', run: ([t]) => str(t).length },
  replace: { min: 3, max: 3, help: 'replace(text, find, with)', run: ([t, f, w]) => (str(f) === '' ? str(t) : str(t).split(str(f)).join(str(w))) },
  text: { min: 1, max: 2, help: 'text(number, places) as text', run: ([x, n]) => (Number.isFinite(num(x)) ? (n === undefined ? str(num(x)) : roundTo(num(x), Math.max(0, Math.min(6, Math.trunc(num(n))))).toFixed(Math.max(0, Math.min(6, Math.trunc(num(n)))))) : '') },
};
// aliases people may know from Excel
FUNCTIONS.mid = FUNCTIONS.substring;
FUNCTIONS.avg = FUNCTIONS.average;

export function roundTo(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round((n + Math.sign(n) * Number.EPSILON) * f) / f;
}

export function parseFormula(src: string): Ast {
  if (src.length > FORMULA_MAX) throw new FormulaError(`is longer than ${FORMULA_MAX} characters`);
  // a name may be dotted once: "items.amount" is the total of column amount of the data grid items
  const tokens = src.match(/\s+|"(?:[^"]|"")*"?|\d+(?:\.\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?|<>|<=|>=|[-+*/(),&=<>]|./g) ?? [];
  const toks = tokens.filter((t) => !/^\s+$/.test(t));
  let i = 0;
  let depth = 0;
  const peek = () => toks[i];
  const expect = (t: string) => {
    if (toks[i] !== t) throw new FormulaError(toks[i] === undefined ? `is incomplete - expected "${t}"` : `has an unexpected "${toks[i]}" - expected "${t}"`);
    i++;
  };

  // lowest to highest: comparison, & (join), + -, * /, unary minus
  const compare = (): Ast => {
    let a = join();
    while (['=', '<>', '<', '>', '<=', '>='].includes(peek())) a = { t: 'bin', op: toks[i++] as BinOp, a, b: join() };
    return a;
  };
  const join = (): Ast => {
    let a = expr();
    while (peek() === '&') a = { t: 'bin', op: toks[i++] as BinOp, a, b: expr() };
    return a;
  };
  const expr = (): Ast => {
    let a = term();
    while (peek() === '+' || peek() === '-') a = { t: 'bin', op: toks[i++] as BinOp, a, b: term() };
    return a;
  };
  const term = (): Ast => {
    let a = unary();
    while (peek() === '*' || peek() === '/') a = { t: 'bin', op: toks[i++] as BinOp, a, b: unary() };
    return a;
  };
  const unary = (): Ast => {
    if (peek() === '-') {
      i++;
      return { t: 'neg', a: unary() };
    }
    return primary();
  };
  const primary = (): Ast => {
    const tok = toks[i++];
    if (tok === undefined) throw new FormulaError('is incomplete');
    if (tok.startsWith('"')) {
      // "quoted text"; a quote inside it is written twice, as in Excel: "say ""hi"""
      if (!/^"(?:[^"]|"")*"$/.test(tok)) throw new FormulaError('has text without its closing "');
      return { t: 'str', v: tok.slice(1, -1).replace(/""/g, '"') };
    }
    if (/^(\d|\.)/.test(tok)) return { t: 'num', v: Number(tok) };
    if (tok === '(') {
      if (++depth > 20) throw new FormulaError('has too many nested brackets');
      const a = compare();
      expect(')');
      depth--;
      return a;
    }
    if (/^[A-Za-z_]/.test(tok)) {
      if (peek() !== '(') return { t: 'ref', name: tok };
      if (tok.includes('.')) throw new FormulaError(`has an unexpected "${tok}("`);
      const fn = FUNCTIONS[tok.toLowerCase()];
      if (!fn) throw new FormulaError(`uses an unknown function "${tok}"`);
      if (++depth > 20) throw new FormulaError('has too many nested brackets');
      i++;
      const args: Ast[] = [];
      if (peek() !== ')') {
        args.push(compare());
        while (peek() === ',') {
          i++;
          args.push(compare());
        }
      }
      expect(')');
      depth--;
      if (args.length < fn.min || args.length > fn.max) throw new FormulaError(`gives ${tok}() the wrong number of values`);
      return { t: 'call', fn: tok.toLowerCase(), args };
    }
    throw new FormulaError(`has an unexpected "${tok}"`);
  };

  if (toks.length === 0) throw new FormulaError('is empty');
  const ast = compare();
  if (i < toks.length) throw new FormulaError(`has an unexpected "${toks[i]}"`);
  return ast;
}

/** Keys of other controls (or columns) a formula reads. */
export function formulaRefs(ast: Ast, out = new Set<string>()): Set<string> {
  if (ast.t === 'ref') out.add(ast.name);
  else if (ast.t === 'neg') formulaRefs(ast.a, out);
  else if (ast.t === 'bin') { formulaRefs(ast.a, out); formulaRefs(ast.b, out); }
  else if (ast.t === 'call') ast.args.forEach((a) => formulaRefs(a, out));
  return out;
}

/**
 * The value of a formula. An empty control counts as 0 (or "" in text), so "a + b" still works when b is
 * optional - but when every control the formula reads is empty the result is null (shown empty), as it is
 * for any number that is not finite (x / 0, arithmetic on text that is not a number).
 */
export function evalValue(ast: Ast, vars: Record<string, FormulaValue | undefined>): FormulaValue {
  const refs = [...formulaRefs(ast)];
  if (refs.length > 0 && refs.every((r) => vars[r] === null || vars[r] === undefined || vars[r] === '')) return null;
  const run = (n: Ast): FormulaValue => {
    switch (n.t) {
      case 'num': return n.v;
      case 'str': return n.v;
      case 'ref': return vars[n.name] ?? null;
      case 'neg': return -num(run(n.a));
      case 'bin': {
        const a = run(n.a), b = run(n.b);
        switch (n.op) {
          case '+': return num(a) + num(b);
          case '-': return num(a) - num(b);
          case '*': return num(a) * num(b);
          case '/': return num(a) / num(b);
          case '&': return str(a) + str(b);
          default: {
            // numbers compare as numbers; anything else as text, ignoring capitals
            const bothNumbers = Number.isFinite(num(a)) && Number.isFinite(num(b)) && str(a).trim() !== '' && str(b).trim() !== '';
            const c = bothNumbers ? num(a) - num(b) : str(a).toLowerCase().localeCompare(str(b).toLowerCase());
            const r = n.op === '=' ? c === 0 : n.op === '<>' ? c !== 0 : n.op === '<' ? c < 0 : n.op === '>' ? c > 0 : n.op === '<=' ? c <= 0 : c >= 0;
            return r ? 1 : 0;
          }
        }
      }
      case 'call':
        if (n.fn === 'if') return truthy(run(n.args[0])) ? run(n.args[1]) : n.args[2] ? run(n.args[2]) : null;
        return FUNCTIONS[n.fn].run(n.args.map(run));
    }
  };
  const result = run(ast);
  if (typeof result === 'number') return Number.isFinite(result) ? result : null;
  return result;
}

/** The value of a formula as a number (null when it is empty or not a number) - for number and currency results. */
export function evalFormula(ast: Ast, vars: Record<string, FormulaValue | undefined>): number | null {
  const v = evalValue(ast, vars);
  if (v === null || (typeof v === 'string' && v.trim() === '')) return null;
  const n = typeof v === 'number' ? v : Number(v.trim());
  return Number.isFinite(n) ? n : null;
}
