// Turns an existing HTML form into a draft form definition for the administrator to review.
// The HTML is only PARSED here - nothing in it is executed or rendered, scripts and styles are
// ignored, and the draft is validated by the normal createForm schema when it is saved.
import { parse, type HTMLElement } from 'node-html-parser';
import { AppError } from '../http/errors';
import type { FieldProps, FieldRules, FieldType } from './validation';

export interface DraftField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  rules?: FieldRules;
  props?: FieldProps;
}
export interface ImportResult {
  name: string;
  description: string | null;
  fields: DraftField[];
  /** Things the administrator should know: skipped controls, conversions, guesses. */
  warnings: string[];
}

const MAX_FIELDS = 200;
const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const stripMarks = (s: string) => clean(s.replace(/[*:]+\s*$/g, '').replace(/^\s*[*]+/, ''));

/** "first_name", "user[email]", "Cost Centre" -> "firstName", "userEmail", "costCentre" */
function toKey(raw: string): string {
  const words = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  let key = words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  key = key.replace(/^[^a-zA-Z]+/, '');
  return key ? (key[0].toLowerCase() + key.slice(1)).slice(0, 90) : '';
}
const humanize = (raw: string) => {
  const s = clean(raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-[\].]+/g, ' '));
  return s ? s[0].toUpperCase() + s.slice(1) : '';
};

function labelFor(el: HTMLElement, root: HTMLElement): string {
  const id = el.getAttribute('id');
  if (id) {
    const byFor = root.querySelectorAll('label').find((l) => l.getAttribute('for') === id);
    if (byFor && clean(byFor.text)) return stripMarks(byFor.text);
  }
  const wrapping = el.closest('label');
  if (wrapping) {
    // the label's own words, without the text of a <select>/<textarea> nested inside it
    let text = wrapping.text;
    for (const inner of wrapping.querySelectorAll('select, textarea')) text = text.replace(inner.text, ' ');
    if (clean(text)) return stripMarks(text);
  }
  return stripMarks(el.getAttribute('aria-label') ?? '') || stripMarks(el.getAttribute('placeholder') ?? '') || stripMarks(el.getAttribute('title') ?? '');
}

const num = (v: string | undefined) => (v !== undefined && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
function safePattern(p: string | undefined): string | undefined {
  if (!p || p.length > 300) return undefined;
  try {
    new RegExp(`^(?:${p})$`);
    return `^(?:${p})$`; // HTML patterns are implicitly anchored
  } catch {
    return undefined;
  }
}
const looksLikeMoney = (s: string) => /\b(amount|cost|price|total|budget|fee|salary|payment|value)\b/i.test(s) || /[$£€]/.test(s);

export function importHtmlForm(html: string): ImportResult {
  const doc = parse(html, { comment: false, blockTextElements: { script: false, style: false, noscript: false, pre: true } });
  const warnings: string[] = [];

  // pick the form with the most controls; fall back to the whole document
  const forms = doc.querySelectorAll('form');
  const controlsOf = (n: HTMLElement) => n.querySelectorAll('input, select, textarea');
  let scope: HTMLElement = doc;
  if (forms.length) {
    scope = forms.reduce((best, f) => (controlsOf(f).length > controlsOf(best).length ? f : best), forms[0]);
    if (forms.length > 1) warnings.push(`The file contains ${forms.length} forms; the one with the most fields was imported.`);
  } else {
    warnings.push('No <form> element was found; every input on the page was imported.');
  }

  const fields: DraftField[] = [];
  const usedKeys = new Set<string>();
  const uniqueKey = (wanted: string, fallback: string) => {
    const base = toKey(wanted) || toKey(fallback) || 'field';
    let key = base;
    for (let i = 2; usedKeys.has(key); i++) key = `${base}${i}`;
    usedKeys.add(key);
    return key;
  };
  const handledGroups = new Set<string>();
  const skipped: Record<string, number> = {};
  const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);

  for (const el of controlsOf(scope)) {
    if (fields.length >= MAX_FIELDS) {
      warnings.push(`Only the first ${MAX_FIELDS} fields were imported.`);
      break;
    }
    const tag = el.tagName.toLowerCase();
    const name = clean(el.getAttribute('name')) || clean(el.getAttribute('id'));
    const type = tag === 'input' ? clean(el.getAttribute('type')).toLowerCase() || 'text' : tag;
    const required = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';
    if (el.hasAttribute('disabled')) { skip('disabled'); continue; }

    if (['hidden', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
    if (type === 'password') { skip('password'); continue; }
    if (type === 'file') { skip('file upload'); continue; }

    // ---- radio groups and multi-checkbox groups share a name ----
    if (type === 'radio' || type === 'checkbox') {
      const group = name ? controlsOf(scope).filter((o) => o.tagName === 'INPUT' && clean(o.getAttribute('type')).toLowerCase() === type && clean(o.getAttribute('name')) === clean(el.getAttribute('name'))) : [el];
      const groupId = `${type}:${name}`;
      if (group.length > 1 || type === 'radio') {
        if (handledGroups.has(groupId)) continue;
        handledGroups.add(groupId);
        const legend = clean(el.closest('fieldset')?.querySelector('legend')?.text);
        const groupLabel = stripMarks(legend) || humanize(name) || 'Choice';
        const optionLabels = group.map((o) => labelFor(o, scope) || clean(o.getAttribute('value'))).filter(Boolean);
        fields.push({
          key: uniqueKey(name, groupLabel),
          label: groupLabel,
          type: type === 'radio' ? 'radio' : 'multiselect', // radio buttons / "tick all that apply"
          required: group.some((o) => o.hasAttribute('required')),
          options: [...new Set(optionLabels)],
        });
        continue;
      }
      fields.push({ key: uniqueKey(name, labelFor(el, scope)), label: labelFor(el, scope) || humanize(name) || 'Tick box', type: 'checkbox', required });
      continue;
    }

    const label = labelFor(el, scope) || humanize(name) || 'Field';
    const key = uniqueKey(name, label);
    const rules: FieldRules = {};

    if (tag === 'select') {
      const options = [...new Set(el.querySelectorAll('option').filter((o) => clean(o.getAttribute('value') ?? o.text) !== '' && !o.hasAttribute('disabled')).map((o) => clean(o.text) || clean(o.getAttribute('value'))))];
      if (el.hasAttribute('multiple') && options.length) {
        fields.push({ key, label, type: 'multiselect', required, options: options.slice(0, 200) });
      } else if (options.length === 0) {
        warnings.push(`"${label}" is a drop-down with no options (probably filled in by a script); it was imported as text.`);
        fields.push({ key, label, type: 'text', required });
      } else fields.push({ key, label, type: 'select', required, options: options.slice(0, 200) });
      continue;
    }

    const maxLength = num(el.getAttribute('maxlength'));
    const minLength = num(el.getAttribute('minlength'));
    if (tag === 'textarea') {
      if (maxLength && maxLength <= 4000) rules.maxLength = maxLength;
      if (minLength) rules.minLength = minLength;
      fields.push({ key, label, type: 'textarea', required, ...(Object.keys(rules).length ? { rules } : {}) });
      continue;
    }

    let fieldType: DraftField['type'] = 'text';
    if (type === 'email') fieldType = 'email';
    else if (type === 'date') fieldType = 'date';
    else if (type === 'tel' || type === 'url' || type === 'time' || type === 'month' || type === 'week' || type === 'color') fieldType = type;
    else if (type === 'datetime-local') fieldType = 'datetime';
    else if (type === 'number' || type === 'range') {
      const step = el.getAttribute('step');
      fieldType = type === 'range' ? 'range' : step === '0.01' || step === '.01' || looksLikeMoney(`${label} ${name}`) ? 'currency' : 'number';
      const min = num(el.getAttribute('min'));
      const max = num(el.getAttribute('max'));
      if (min !== undefined) rules.min = min;
      if (max !== undefined) rules.max = max;
    }
    const placeholder = clean(el.getAttribute('placeholder'));
    if (fieldType === 'text' || fieldType === 'email' || fieldType === 'tel' || fieldType === 'url') {
      if (maxLength && maxLength <= 500) rules.maxLength = maxLength;
      if (minLength) rules.minLength = minLength;
      const pattern = safePattern(el.getAttribute('pattern'));
      if (pattern) rules.pattern = pattern;
      else if (el.getAttribute('pattern')) warnings.push(`The validation pattern on "${label}" could not be used and was dropped.`);
    }
    const keepPlaceholder = placeholder && placeholder !== label && placeholder.length <= 200 && ['text', 'email', 'tel', 'url', 'number', 'currency'].includes(fieldType);
    fields.push({ key, label, type: fieldType, required, ...(Object.keys(rules).length ? { rules } : {}), ...(keepPlaceholder ? { props: { placeholder } } : {}) });
  }

  for (const [why, n] of Object.entries(skipped)) {
    warnings.push(
      why === 'file upload' ? `${n} file upload field(s) were skipped - attachments are not supported.`
      : why === 'password' ? `${n} password field(s) were skipped.`
      : `${n} disabled field(s) were skipped.`,
    );
  }
  if (fields.length === 0) throw new AppError(400, 'no_fields', 'No form fields were found in this HTML. Check that the file contains <input>, <select> or <textarea> elements.');

  const heading = clean(scope.querySelector('h1, h2, legend')?.text) || clean(doc.querySelector('h1, h2')?.text);
  const name = (stripMarks(scope.getAttribute?.('aria-label') ?? '') || heading || clean(doc.querySelector('title')?.text) || 'Imported form').slice(0, 200);
  const intro = clean(scope.querySelector('p')?.text);
  return { name, description: intro && intro.length <= 1000 ? intro : null, fields, warnings };
}
