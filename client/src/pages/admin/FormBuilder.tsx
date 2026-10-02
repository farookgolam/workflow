// Visual form builder: a live preview on the same 12-column grid submitters will see.
//  - click a control to edit its properties in the side panel
//  - drag its right edge to resize (snaps to quarter / third / half / two-thirds / three-quarters / full)
//  - drag the bottom edge of a text area to change its height
//  - a data grid's columns (typed, drop-down or calculated from a formula) are edited in the side panel
//  - drag a control onto another to move it before / after it, or drag a new one in from the palette
// Everything the mouse can do is also available from the keyboard through the properties panel.
// "Preview" shows the unsaved form exactly as a submitter gets it (lookups and auto-fill included) and can
// test-submit it: the server runs its real validation and reports what it would store, saving nothing.
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api } from '../../api';
import { AUTOFILL_TYPES, CALC_TYPES, FieldGrid, HEADING_SIZES, alignsFor, formulaNames, formulaProblem, hasWidth, isCalculated, FieldInput, ValueList, WIDTHS, applyLookups, initialValues, isChoice, isFormulaInput, isNumericColumn, isStatic, toPayload, withLookupOptions, type FieldDef, type FieldProps, type FieldRules, type Align, type FieldType, type HeadingSize, type GridColumn, type GridColumnType, type Lookups, type Values, type Width } from '../../fields';
import { FUNCTIONS, FormulaError, formulaRefs, parseFormula } from '../../formula';
import { useLoad } from '../../hooks';

interface LookupTable { lookupId: number; name: string; keyColumn: string; columns: string[]; rows: number }

const PALETTE: { group: string; items: [FieldType, string][] }[] = [
  { group: 'Text', items: [['text', 'Text'], ['textarea', 'Long text'], ['email', 'Email'], ['tel', 'Phone'], ['url', 'Web address']] },
  { group: 'Numbers', items: [['number', 'Number'], ['currency', 'Currency'], ['range', 'Slider']] },
  { group: 'Date & time', items: [['date', 'Date'], ['time', 'Time'], ['datetime', 'Date & time'], ['month', 'Month'], ['week', 'Week']] },
  { group: 'Choices', items: [['select', 'Drop-down'], ['radio', 'Radio buttons'], ['multiselect', 'Tick boxes (many)'], ['checkbox', 'Single tick box'], ['lookup', 'Lookup (Excel)']] },
  { group: 'Other', items: [['grid', 'Data grid'], ['color', 'Colour'], ['sigpad', 'Signature (draw)'], ['signature', 'Signature (typed name)']] },
  { group: 'Layout', items: [['heading', 'Heading'], ['paragraph', 'Paragraph'], ['image', 'Picture'], ['divider', 'Divider']] },
];
const TYPE_LABEL = Object.fromEntries(PALETTE.flatMap((g) => g.items)) as Record<FieldType, string>;
const WIDTH_LABEL: Record<Width, string> = { 3: '¼', 4: '⅓', 6: '½', 8: '⅔', 9: '¾', 12: 'Full' };
const HEADING_SIZE_LABEL: Record<HeadingSize, string> = { small: 'Small', medium: 'Medium', large: 'Large', xlarge: 'Extra large' };
const ALIGN_LABEL: Record<Align, string> = { left: 'Left', center: 'Centre', right: 'Right', justify: 'Justified' };
/** Same limit as the customer logo in Settings: a 300 KB file is about 400,000 characters once encoded. */
const MAX_IMAGE_BYTES = 300_000;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const TEXTY: FieldType[] = ['text', 'textarea', 'email', 'tel', 'url', 'signature'];
const NUMERIC: FieldType[] = ['number', 'currency', 'range'];
const COLUMN_TYPE_LABEL: Record<GridColumnType, string> = { text: 'Text', number: 'Number', currency: 'Currency', date: 'Date', time: 'Time', select: 'Drop-down', calc: 'Calculated' };
/** What a new data grid starts with: a line-items table whose last column is worked out from two others. */
const DEFAULT_COLUMNS: GridColumn[] = [
  { key: 'description', label: 'Description', type: 'text', required: true },
  { key: 'quantity', label: 'Quantity', type: 'number' },
  { key: 'unitPrice', label: 'Unit price', type: 'currency' },
  { key: 'amount', label: 'Amount', type: 'calc', formula: 'quantity * unitPrice', total: true },
];

export const keyify = (s: string) => {
  const k = s.replace(/[^a-zA-Z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^[^a-zA-Z]+/, '');
  return (k.charAt(0).toLowerCase() + k.slice(1)).slice(0, 90);
};

/** Strips empty settings so only meaningful values are sent to the server. */
export function cleanFields(fields: FieldDef[]) {
  const compact = <T extends object>(o: T | null | undefined) => {
    const e = Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '' && !(typeof v === 'number' && Number.isNaN(v)));
    return e.length ? (Object.fromEntries(e) as T) : undefined;
  };
  return fields.map((f) => {
    const calc = isCalculated(f);
    const auto = !calc && AUTOFILL_TYPES.includes(f.type) && !!f.props?.lookupFrom;
    const props = compact<FieldProps>({
      ...f.props,
      width: !hasWidth(f.type) || (f.props?.width ?? 12) === 12 ? undefined : f.props?.width,
      lookupId: f.type === 'lookup' ? f.props?.lookupId : undefined,
      lookupFrom: auto ? f.props?.lookupFrom : undefined,
      align: f.props?.align && alignsFor(f.type).includes(f.props.align) && f.props.align !== 'left' ? f.props.align : undefined,
      imageDataUrl: f.type === 'image' ? f.props?.imageDataUrl : undefined,
      imageAlt: f.type === 'image' ? f.props?.imageAlt : undefined,
      imageHeight: f.type === 'image' ? f.props?.imageHeight : undefined,
      headingSize: f.type === 'heading' && f.props?.headingSize !== 'medium' ? f.props?.headingSize : undefined,
      formatExample: undefined, // a setting that no longer exists: dropped from forms saved while it did
      formula: calc ? f.props?.formula?.trim() : undefined,
      decimals: calc && f.type === 'number' && f.props?.decimals !== undefined && f.props.decimals !== 2 ? f.props.decimals : undefined,
      ...(calc ? { defaultValue: undefined, placeholder: undefined, step: undefined } : {}),
      lookupColumn: auto ? f.props?.lookupColumn : undefined,
      ...(auto || f.type === 'sigpad' ? { defaultValue: undefined, placeholder: undefined } : {}),
      ...(f.type === 'grid'
        ? {
            defaultValue: undefined, placeholder: undefined,
            columns: (f.props?.columns ?? []).map((c): GridColumn => ({
              key: c.key.trim(), label: c.label.trim(), type: c.type,
              ...(c.required && c.type !== 'calc' ? { required: true } : {}),
              ...(c.type === 'select' ? { options: [...new Set((c.options ?? []).map((o) => o.trim()).filter(Boolean))] } : {}),
              ...(c.type === 'calc' ? { formula: (c.formula ?? '').trim(), ...(c.decimals !== undefined && c.decimals !== 2 ? { decimals: c.decimals } : {}) } : {}),
              ...(c.total && isNumericColumn(c.type) ? { total: true } : {}),
            })),
          }
        : { columns: undefined, minRows: undefined, maxRows: undefined }),
    });
    const rules = isStatic(f.type) || f.type === 'grid' || f.type === 'sigpad' || (calc && f.type === 'text') ? undefined : compact<FieldRules>(f.rules);
    return {
      key: f.key.trim(),
      label: f.label.trim(),
      type: f.type,
      required: isStatic(f.type) || auto || calc ? false : f.required,
      ...(isChoice(f.type) ? { options: [...new Set((f.options ?? []).map((o) => o.trim()).filter(Boolean))] } : {}),
      ...(rules ? { rules } : {}),
      ...(props ? { props } : {}),
    };
  });
}

function gridProblems(name: string, cols: GridColumn[], minRows?: number, maxRows?: number): string[] {
  const out: string[] = [];
  if (!cols.some((c) => c.type !== 'calc')) out.push(`"${name}" needs at least one column that people fill in.`);
  if ((minRows ?? 0) > (maxRows ?? 200)) out.push(`"${name}": the minimum number of rows is above the maximum.`);
  const seen = new Set<string>();
  const numeric = new Set(cols.filter((c) => isFormulaInput(c.type)).map((c) => c.key));
  cols.forEach((c, i) => {
    const col = `"${name}", column ${c.label.trim() ? `"${c.label.trim()}"` : i + 1}`;
    if (!c.label.trim()) out.push(`${col} needs a heading.`);
    if (!/^[a-z][a-zA-Z0-9_]{0,99}$/.test(c.key)) out.push(`${col}: the key must start with a lowercase letter and contain only letters, digits and _.`);
    else if (seen.has(c.key)) out.push(`${col}: the key "${c.key}" is used twice.`);
    seen.add(c.key);
    if (c.type === 'select' && !(c.options ?? []).some((o) => o.trim())) out.push(`${col} needs at least one option.`);
    if (c.type === 'calc') {
      if (!(c.formula ?? '').trim()) out.push(`${col} needs a formula.`);
      else {
        try {
          const bad = [...formulaRefs(parseFormula(c.formula!))].find((r) => !numeric.has(r));
          if (bad) out.push(`${col}: the formula uses "${bad}", which is not the key of a number, currency, time or earlier calculated column.`);
        } catch (err) { out.push(`${col}: the formula ${err instanceof FormulaError ? err.message : 'cannot be read'}.`); }
      }
      numeric.add(c.key);
    }
  });
  return out;
}

/** Problems that would make the save fail, phrased for the person building the form. */
export function fieldProblems(fields: FieldDef[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    const name = f.label.trim() || `Control ${i + 1}`;
    if (!f.label.trim()) out.push(`Control ${i + 1} needs a label.`);
    if (!/^[a-z][a-zA-Z0-9_]{0,99}$/.test(f.key)) out.push(`"${name}": the key must start with a lowercase letter and contain only letters, digits and _.`);
    else if (seen.has(f.key)) out.push(`"${name}": the key "${f.key}" is used twice.`);
    seen.add(f.key);
    if (isChoice(f.type) && !(f.options ?? []).some((o) => o.trim())) out.push(`"${name}" needs at least one option.`);
    if (f.type === 'image' && !f.props?.imageDataUrl) out.push(`"${name}": choose a picture.`);
    if (f.type === 'lookup' && !f.props?.lookupId) out.push(`"${name}": choose which lookup table it uses.`);
    if (f.props?.lookupFrom && AUTOFILL_TYPES.includes(f.type)) {
      if (!fields.some((x) => x.key === f.props!.lookupFrom && x.type === 'lookup')) out.push(`"${name}" is filled from a lookup control that no longer exists.`);
      else if (!f.props.lookupColumn) out.push(`"${name}": choose which column fills it.`);
    }
    if (f.type === 'grid') out.push(...gridProblems(name, f.props?.columns ?? [], f.props?.minRows, f.props?.maxRows));
    if (CALC_TYPES.includes(f.type) && f.props?.formula !== undefined && !f.props.formula.trim()) out.push(`"${name}": type the formula it is worked out from, or untick "Work this out from other fields".`);
  });
  const formulas = formulaProblem(fields.filter((f) => !(CALC_TYPES.includes(f.type) && f.props?.formula !== undefined && !f.props.formula.trim())));
  if (formulas) out.push(formulas);
  return out;
}

export interface StoredValue { key: string; label: string; type: string; value: string | null; autoFilled: boolean }

/**
 * The unsaved form, filled in like a submitter would. Nothing here is ever saved or sent to anyone.
 * The approval chain's preview reuses it as its first stage: `extra` sits under the form (the step 1 hand-off),
 * `check` can stop the test submit, and `onPassed` receives what a real request would store.
 */
export function FormPreview({ fields, extra, check, onPassed }: { fields: FieldDef[]; extra?: ReactNode; check?(): boolean; onPassed?(stored: StoredValue[]): void }) {
  const problems = fieldProblems(fields);
  const [form, setForm] = useState<{ defs: FieldDef[]; lookups: Lookups } | null>(null);
  const [values, setValues] = useState<Values>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [stored, setStored] = useState<StoredValue[] | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (problems.length) return;
    setMessage('');
    api<{ lookups: Lookups }>('/admin/forms/preview/lookups', { method: 'POST', body: { fields: cleanFields(fields) } })
      .then(({ lookups }) => {
        const defs = withLookupOptions(cleanFields(fields).map((f, i) => ({ options: null, rules: null, props: null, ...f, id: i, sortOrder: i + 1 }) as FieldDef), lookups);
        setForm({ defs, lookups });
        setValues(applyLookups(defs, initialValues(defs), lookups));
        setErrors({});
        setStored(null);
      })
      .catch((err) => setMessage(err instanceof ApiError ? err.details[0]?.message ?? err.message : 'The preview could not be loaded.'));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const testSubmit = async () => {
    if (!form || (check && !check())) return;
    setBusy(true); setErrors({}); setStored(null); setMessage('');
    try {
      const res = await api<{ stored: StoredValue[] }>('/admin/forms/preview/validate', { method: 'POST', body: { fields: cleanFields(fields), values: toPayload(form.defs, values) } });
      setStored(res.stored);
      onPassed?.(res.stored);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation_failed' && err.details.some((d) => form.defs.some((f) => f.key === d.path))) {
        setErrors(err.fieldErrors);
        setMessage('The server would reject this submission - see the messages next to the boxes.');
      } else setMessage(err instanceof ApiError ? err.details[0]?.message ?? err.message : 'Something went wrong.');
    } finally { setBusy(false); }
  };

  if (problems.length) return <div className="b-canvas"><p><strong>Fix these in Design first:</strong></p><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>;
  if (!form) return <div className="b-canvas"><p className={message ? 'error' : 'muted'} role={message ? 'alert' : undefined}>{message || 'Loading preview…'}</p></div>;
  return (
    <div className="b-canvas b-live">
      <p className="hint">This is what the person filling in the form gets, including your unsaved changes. Try the lookups, then <strong>Test submit</strong>: the server checks the answers exactly as it would for a real request. Nothing is saved and nobody is emailed.</p>
      <FieldGrid defs={form.defs}>
        {(f) => <FieldInput def={f} value={values[f.key]} error={errors[f.key]} disabled={busy} onChange={(v) => { setStored(null); setValues((cur) => applyLookups(form.defs, { ...cur, [f.key]: v }, form.lookups)); }} />}
      </FieldGrid>
      {extra}
      <div className="b-row" style={{ marginTop: '1rem' }}>
        <button type="button" className="primary" disabled={busy} onClick={testSubmit}>{busy ? 'Checking…' : 'Test submit'}</button>
        <button type="button" disabled={busy} onClick={load}>Start again</button>
      </div>
      {message && <p className="error" role="alert">{message}</p>}
      {stored && (
        <div className="b-result" role="status">
          <p><strong>Passed.</strong> A real request would store these values{stored.some((v) => v.autoFilled) && <> - the ones marked <em>auto-filled</em> were taken from the lookup table by the server</>}:</p>
          <ValueList items={stored.map((v) => ({ ...v, label: v.autoFilled ? `${v.label} (auto-filled)` : v.label }))} />
        </div>
      )}
    </div>
  );
}

export function FormBuilder({ fields, onChange }: { fields: FieldDef[]; onChange(f: FieldDef[]): void }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [mode, setMode] = useState<'design' | 'preview'>('design');
  const canvas = useRef<HTMLDivElement>(null);
  const tables = useLoad<{ lookups: LookupTable[] }>('/admin/lookups').data?.lookups ?? [];
  const lookupControls = fields.filter((f) => f.type === 'lookup');
  const tableOf = (controlKey: string | undefined) =>
    tables.find((t) => t.lookupId === fields.find((f) => f.key === controlKey)?.props?.lookupId);
  const sel = selected !== null && selected < fields.length ? fields[selected] : null;

  const patch = (i: number, p: Partial<FieldDef>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const patchProps = (i: number, p: Partial<FieldProps>) => patch(i, { props: { ...fields[i].props, ...p } });
  const patchRules = (i: number, r: Partial<FieldRules>) => patch(i, { rules: { ...fields[i].rules, ...r } });

  const add = (type: FieldType, at = fields.length) => {
    const base = TYPE_LABEL[type];
    let key = keyify(base) || 'field';
    for (let n = 2; fields.some((f) => f.key === key); n++) key = `${keyify(base) || 'field'}${n}`;
    const def: FieldDef = {
      key, label: type === 'paragraph' ? 'Paragraph' : base, type, required: false,
      options: isChoice(type) ? ['Option 1', 'Option 2'] : null, rules: null,
      props: type === 'paragraph' ? { text: 'Explanatory text for the person filling in the form.' } : type === 'grid' ? { columns: DEFAULT_COLUMNS, minRows: 1 } : null,
    };
    onChange([...fields.slice(0, at), def, ...fields.slice(at)]);
    setSelected(at);
  };

  // ---- drag and drop: move a control, or bring a new one in from the palette ----
  // The form is a flowing 12-column grid, so a drop means "before" or "after" the control under the pointer:
  // left / right half for a control that shares its row, top / bottom half for a full-width one.
  const dragging = useRef<{ from: number } | { type: FieldType } | null>(null);
  const [drop, setDrop] = useState<{ index: number; side: 'before' | 'after'; axis: 'x' | 'y' } | null>(null);
  const endDrag = () => { dragging.current = null; setDrop(null); };
  const dragOverItem = (e: ReactDragEvent<HTMLElement>, i: number) => {
    if (!dragging.current) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'from' in dragging.current ? 'move' : 'copy';
    const r = e.currentTarget.getBoundingClientRect();
    const grid = canvas.current?.querySelector('.fgrid')?.getBoundingClientRect();
    const axis = grid && r.width > grid.width * 0.8 ? 'y' : 'x';
    const side = (axis === 'x' ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2) ? 'before' : 'after';
    if (drop?.index !== i || drop.side !== side || drop.axis !== axis) setDrop({ index: i, side, axis });
  };
  const dropAt = (target: number) => {
    const src = dragging.current;
    endDrag();
    if (!src) return;
    if ('type' in src) return add(src.type, target);
    if (target === src.from || target === src.from + 1) return; // dropped where it already is
    const next = [...fields];
    const [item] = next.splice(src.from, 1);
    const at = target > src.from ? target - 1 : target;
    next.splice(at, 0, item);
    onChange(next);
    setSelected(at);
  };
  const [imageError, setImageError] = useState('');
  const chooseImage = (i: number, file: File | undefined) => {
    setImageError('');
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type)) return setImageError('Choose a PNG, JPG, GIF or WebP picture.');
    if (file.size > MAX_IMAGE_BYTES) return setImageError('That picture is too large - keep it under 300 KB.');
    const reader = new FileReader();
    reader.onload = () => patchProps(i, { imageDataUrl: String(reader.result), imageAlt: fields[i].props?.imageAlt ?? file.name.replace(/\.[^.]+$/, '') });
    reader.readAsDataURL(file);
  };
  const patchColumn = (i: number, ci: number, c: Partial<GridColumn>) => patchProps(i, { columns: (fields[i].props?.columns ?? []).map((x, j) => (j === ci ? { ...x, ...c } : x)) });
  const addColumn = (i: number) => {
    const cols = fields[i].props?.columns ?? [];
    let key = 'column';
    for (let n = 2; cols.some((c) => c.key === key); n++) key = `column${n}`;
    patchProps(i, { columns: [...cols, { key, label: 'Column', type: 'text' }] });
  };
  const moveColumn = (i: number, ci: number, d: number) => {
    const cols = [...(fields[i].props?.columns ?? [])];
    [cols[ci], cols[ci + d]] = [cols[ci + d], cols[ci]];
    patchProps(i, { columns: cols });
  };
  const move = (i: number, d: number) => {
    const next = [...fields];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
    setSelected(i + d);
  };
  const duplicate = (i: number) => {
    const src = fields[i];
    let key = `${src.key}Copy`;
    for (let n = 2; fields.some((f) => f.key === key); n++) key = `${src.key}Copy${n}`;
    onChange([...fields.slice(0, i + 1), { ...src, key, label: `${src.label} (copy)` }, ...fields.slice(i + 1)]);
    setSelected(i + 1);
  };
  const remove = (i: number) => { onChange(fields.filter((_, j) => j !== i)); setSelected(null); };

  // ---- drag to resize: width snaps to the grid, text-area height to whole rows ----
  const startResize = (e: ReactPointerEvent, i: number, axis: 'x' | 'y') => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(i);
    const cell = (e.currentTarget as HTMLElement).closest('.b-item') as HTMLElement;
    const grid = canvas.current!.querySelector('.fgrid') as HTMLElement;
    const left = cell.getBoundingClientRect().left;
    const colW = grid.getBoundingClientRect().width / 12;
    const startY = e.clientY;
    const startRows = fields[i].props?.rows ?? 4;
    const onMove = (ev: PointerEvent) => {
      if (axis === 'x') {
        const want = (ev.clientX - left) / colW;
        const width = WIDTHS.reduce((best, w) => (Math.abs(w - want) < Math.abs(best - want) ? w : best), 12 as Width);
        if (width !== (fields[i].props?.width ?? 12)) patchProps(i, { width });
      } else {
        const rows = Math.max(2, Math.min(20, startRows + Math.round((ev.clientY - startY) / 21)));
        if (rows !== (fields[i].props?.rows ?? 4)) patchProps(i, { rows });
      }
    };
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); document.body.classList.remove('resizing'); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.classList.add('resizing');
  };

  const num = (v: string) => (v === '' ? undefined : Number(v));

  const modeBar = (
    <div className="seg b-mode" role="group" aria-label="Builder mode">
      <button type="button" className={mode === 'design' ? 'on' : ''} aria-pressed={mode === 'design'} onClick={() => setMode('design')}>Design</button>
      <button type="button" className={mode === 'preview' ? 'on' : ''} aria-pressed={mode === 'preview'} disabled={fields.length === 0} onClick={() => { setSelected(null); setMode('preview'); }}>Preview &amp; test</button>
    </div>
  );
  if (mode === 'preview') return <div className="b-wrap">{modeBar}<FormPreview fields={fields} /></div>;

  return (
    <div className="b-wrap">{modeBar}
    <div className="builder">
      <div className="b-canvas" ref={canvas} onClick={() => setSelected(null)}
        onDragOver={(e) => { if (!dragging.current) return; e.preventDefault(); if (drop) setDrop(null); }}
        onDrop={(e) => { e.preventDefault(); dropAt(fields.length); }}>
        {fields.length === 0 ? <p className="muted center" style={{ padding: '2rem 0' }}>Add a control from the panel on the right.</p> : (
          <FieldGrid defs={fields}>
            {(f, i) => (
              <div
                className={`b-item${selected === i ? ' selected' : ''}${drop?.index === i ? ` b-drop-${drop.side}-${drop.axis}` : ''}`}
                draggable
                onDragStart={(e) => {
                  if (document.body.classList.contains('resizing')) return e.preventDefault(); // a resize handle is being dragged
                  dragging.current = { from: i };
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', f.label);
                }}
                onDragOver={(e) => dragOverItem(e, i)}
                onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropAt(drop?.index === i && drop.side === 'after' ? i + 1 : i); }}
                onDragEnd={endDrag}
                role="button" tabIndex={0} aria-pressed={selected === i} aria-label={`${TYPE_LABEL[f.type]}: ${f.label}. Press Enter to edit.`}
                onClick={(e) => { e.stopPropagation(); setSelected(i); }}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setSelected(i); } }}
              >
                <div className="b-preview" aria-hidden="true"><FieldInput def={f} value={undefined} onChange={() => {}} /></div>
                <span className="b-type">{TYPE_LABEL[f.type]}{hasWidth(f.type) && `, ${WIDTH_LABEL[f.props?.width ?? 12]}`}{f.props?.lookupFrom && ', auto-filled'}{isCalculated(f) && ', calculated'}</span>
                {selected === i && (
                  <div className="b-tools" onClick={(e) => e.stopPropagation()}>
                    <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move earlier" title="Move earlier">↑</button>
                    <button type="button" disabled={i === fields.length - 1} onClick={() => move(i, 1)} aria-label="Move later" title="Move later">↓</button>
                    <button type="button" onClick={() => duplicate(i)} aria-label="Duplicate" title="Duplicate">⧉</button>
                    <button type="button" onClick={() => remove(i)} aria-label="Delete control" title="Delete">✕</button>
                  </div>
                )}
                {selected !== i && <button type="button" className="b-remove" onClick={(e) => { e.stopPropagation(); remove(i); }} aria-label={`Remove ${f.label || TYPE_LABEL[f.type]}`} title="Remove this control">✕</button>}
                {hasWidth(f.type) && <span className="b-handle-x" onPointerDown={(e) => startResize(e, i, 'x')} title="Drag to resize" />}
                {f.type === 'textarea' && <span className="b-handle-y" onPointerDown={(e) => startResize(e, i, 'y')} title="Drag to change height" />}
              </div>
            )}
          </FieldGrid>
        )}
      </div>

      <aside className="b-side">
        {sel && selected !== null ? (
          <div className="b-props">
            <div className="prev-head"><strong>{TYPE_LABEL[sel.type]} properties</strong><button type="button" className="link" onClick={() => setSelected(null)}>Done</button></div>

            <label>{sel.type === 'heading' ? 'Heading text' : sel.type === 'divider' || sel.type === 'paragraph' || sel.type === 'image' ? 'Name (not shown)' : 'Label'}
              <input value={sel.label} onChange={(e) => patch(selected, { label: e.target.value, ...(sel.key === keyify(sel.label) || !sel.key ? { key: keyify(e.target.value) } : {}) })} />
            </label>
            {sel.type === 'paragraph' && <label>Text<textarea rows={4} value={sel.props?.text ?? ''} onChange={(e) => patchProps(selected, { text: e.target.value })} /></label>}
            {sel.type === 'image' && (
              <>
                <label>Picture
                  <input type="file" accept={IMAGE_TYPES.join(',')} onChange={(e) => { chooseImage(selected, e.target.files?.[0]); e.target.value = ''; }} />
                  <span className="hint">PNG, JPG, GIF or WebP, up to 300 KB - a logo, for example.</span>
                </label>
                {imageError && <p className="field-error" role="alert">{imageError}</p>}
                <label>Description (for screen readers)<input value={sel.props?.imageAlt ?? ''} placeholder="Company logo" onChange={(e) => patchProps(selected, { imageAlt: e.target.value || undefined })} /></label>
                <label>Largest height (pixels)<input type="number" min={16} max={800} value={sel.props?.imageHeight ?? 120} onChange={(e) => patchProps(selected, { imageHeight: Math.max(16, Math.min(800, Math.trunc(Number(e.target.value)) || 120)) })} /></label>
              </>
            )}
            {hasWidth(sel.type) && (
              <div className="b-row"><span className="b-cap">Width</span>
                <div className="seg">{WIDTHS.map((w) => <button type="button" key={w} className={(sel.props?.width ?? 12) === w ? 'on' : ''} onClick={() => patchProps(selected, { width: w })}>{WIDTH_LABEL[w]}</button>)}</div>
              </div>
            )}
            {sel.type === 'heading' && (
              <div className="b-row"><span className="b-cap">Size</span>
                <div className="seg" role="group" aria-label="Heading size">
                  {HEADING_SIZES.map((z) => (
                    <button type="button" key={z} className={(sel.props?.headingSize ?? 'medium') === z ? 'on' : ''} aria-pressed={(sel.props?.headingSize ?? 'medium') === z}
                      onClick={() => patchProps(selected, { headingSize: z === 'medium' ? undefined : z })}>{HEADING_SIZE_LABEL[z]}</button>
                  ))}
                </div>
              </div>
            )}
            {alignsFor(sel.type).length > 0 && (
              <div className="b-row"><span className="b-cap">{isStatic(sel.type) ? 'Alignment' : 'Text alignment'}</span>
                <div className="seg" role="group" aria-label={isStatic(sel.type) ? 'Alignment' : 'Text alignment'}>
                  {alignsFor(sel.type).map((a) => (
                    <button type="button" key={a} 
                      className={(sel.props?.align ?? 'left') === a ? 'on' : ''} aria-pressed={(sel.props?.align ?? 'left') === a}
                      onClick={() => patchProps(selected, { align: a === 'left' ? undefined : a })}>{ALIGN_LABEL[a]}</button>
                  ))}
                </div>
              </div>
            )}

            {!isStatic(sel.type) && (
              <>
                <label>Control type
                  <select value={sel.type} onChange={(e) => { const t = e.target.value as FieldType; patch(selected, { type: t, options: isChoice(t) ? sel.options?.length ? sel.options : ['Option 1', 'Option 2'] : null, ...(t === 'grid' && !sel.props?.columns?.length ? { props: { ...sel.props, columns: DEFAULT_COLUMNS, minRows: 1 } } : {}) }); }}>
                    {PALETTE.filter((g) => g.group !== 'Layout').map((g) => <optgroup key={g.group} label={g.group}>{g.items.map(([t, l]) => <option key={t} value={t}>{l}</option>)}</optgroup>)}
                  </select>
                </label>
                {sel.props?.formula === undefined && <label className="check"><input type="checkbox" checked={sel.required} onChange={(e) => patch(selected, { required: e.target.checked })} /><span>Required</span></label>}

                {CALC_TYPES.includes(sel.type) && !sel.props?.lookupFrom && (() => {
                  const on = sel.props?.formula !== undefined;
                  const names = formulaNames(fields.filter((f) => f.key !== sel.key));
                  return (
                    <fieldset className="b-auto">
                      <legend>Calculated</legend>
                      <label className="check"><input type="checkbox" checked={on} onChange={(e) => patchProps(selected, e.target.checked ? { formula: '' } : { formula: undefined, decimals: undefined })} /><span>Work this out from other fields</span></label>
                      {on && (
                        <>
                          <label>Formula
                            <input className="mono" value={sel.props?.formula ?? ''} placeholder={sel.type === 'text' ? 'firstName & " " & lastName' : names.length >= 2 ? `${names[0]} * ${names[1]}` : 'quantity * unitPrice'} onChange={(e) => patchProps(selected, { formula: e.target.value })} />
                          </label>
                          {sel.type === 'number' && <label>Decimal places<input type="number" min={0} max={6} value={sel.props?.decimals ?? 2} onChange={(e) => patchProps(selected, { decimals: Math.max(0, Math.min(6, Math.trunc(Number(e.target.value)) || 0)) })} /></label>}
                          <p className="hint" style={{ margin: 0 }}>
                            {names.length ? <>Use these keys: <span className="mono">{names.join(', ')}</span>. </> : 'Add the controls it is worked out from first. '}
                            Combine them with + - * / and brackets, &amp; to join text, "quoted text", and = &lt;&gt; &lt; &gt; &lt;= &gt;= to compare (for if). A time counts as hours, a tick box as 1 or 0, and a data grid column written grid.column gives its total. People see the result update as they type; it is worked out again when the form is submitted.
                          </p>
                          <details className="b-fns"><summary className="small">Functions</summary>
                            <ul className="small mono" style={{ margin: '.3rem 0 0', paddingLeft: '1.1rem' }}>
                              {Object.entries(FUNCTIONS).filter(([k, f]) => FUNCTIONS[k] === f && !['mid', 'avg'].includes(k)).map(([k, f]) => <li key={k}>{f.help}</li>)}
                            </ul>
                          </details>
                        </>
                      )}
                    </fieldset>
                  );
                })()}

                {sel.type === 'textarea' && <label>Height (rows)<input type="number" min={2} max={20} value={sel.props?.rows ?? 4} onChange={(e) => patchProps(selected, { rows: Math.max(2, Math.min(20, Number(e.target.value) || 4)) })} /></label>}

                {sel.type === 'lookup' && (
                  tables.length === 0 ? <p className="hint">No lookup tables yet. <Link to="/admin/lookups">Import an Excel file</Link> first, then come back.</p> : (
                    <label>Lookup table
                      <select value={sel.props?.lookupId ?? ''} onChange={(e) => patchProps(selected, { lookupId: e.target.value ? Number(e.target.value) : undefined })}>
                        <option value="">Choose…</option>
                        {tables.map((t) => <option key={t.lookupId} value={t.lookupId}>{t.name} ({t.rows} rows, key: {t.keyColumn})</option>)}
                      </select>
                      <span className="hint">People choose a value of the key column. Other controls can then be filled from the same row.</span>
                    </label>
                  )
                )}

                {sel.type === 'grid' && (
                  <fieldset className="b-auto b-cols">
                    <legend>Columns</legend>
                    {(sel.props?.columns ?? []).map((c, ci, all) => (
                      <details key={ci} className="b-col" open={all.length <= 1 || undefined}>
                        <summary><span>{c.label || `Column ${ci + 1}`}</span><span className="muted small">{COLUMN_TYPE_LABEL[c.type]}</span></summary>
                        <label>Heading
                          <input value={c.label} onChange={(e) => patchColumn(selected, ci, { label: e.target.value, ...(c.key === keyify(c.label) || !c.key ? { key: keyify(e.target.value) } : {}) })} />
                        </label>
                        <div className="b-pair">
                          <label>Type
                            <select value={c.type} onChange={(e) => { const t = e.target.value as GridColumnType; patchColumn(selected, ci, { type: t, ...(t === 'select' && !c.options?.length ? { options: ['Option 1', 'Option 2'] } : {}) }); }}>
                              {(Object.keys(COLUMN_TYPE_LABEL) as GridColumnType[]).map((t) => <option key={t} value={t}>{COLUMN_TYPE_LABEL[t]}</option>)}
                            </select>
                          </label>
                          <label>Key<input className="mono" value={c.key} onChange={(e) => patchColumn(selected, ci, { key: e.target.value })} /></label>
                        </div>
                        {c.type === 'select' && <label>Options (one per line)<textarea rows={3} value={(c.options ?? []).join('\n')} onChange={(e) => patchColumn(selected, ci, { options: e.target.value.split('\n') })} /></label>}
                        {c.type === 'calc' && (
                          <>
                            <label>Formula
                              <input className="mono" value={c.formula ?? ''} placeholder="quantity * unitPrice" onChange={(e) => patchColumn(selected, ci, { formula: e.target.value })} />
                              <span className="hint">Use the keys of number, currency and time columns{all.some((x) => isFormulaInput(x.type)) && <> ({all.filter((x) => isFormulaInput(x.type)).map((x) => x.key).join(', ')})</>} with + - * / and brackets. Also: round(x, places), min(a, b), max(a, b), abs(x).{all.some((x) => x.type === 'time') && <> A time counts as hours, so <code>timeOut - timeIn</code> gives the hours between them; use <code>elapsed(timeIn, timeOut)</code> if a shift can run past midnight.</>}</span>
                            </label>
                            <label>Decimal places<input type="number" min={0} max={6} value={c.decimals ?? 2} onChange={(e) => patchColumn(selected, ci, { decimals: Math.max(0, Math.min(6, Math.trunc(Number(e.target.value)) || 0)) })} /></label>
                          </>
                        )}
                        {c.type !== 'calc' && <label className="check"><input type="checkbox" checked={!!c.required} onChange={(e) => patchColumn(selected, ci, { required: e.target.checked || undefined })} /><span>Required in every row</span></label>}
                        {isNumericColumn(c.type) && <label className="check"><input type="checkbox" checked={!!c.total} onChange={(e) => patchColumn(selected, ci, { total: e.target.checked || undefined })} /><span>Show a total under this column</span></label>}
                        <div className="b-row">
                          <button type="button" disabled={ci === 0} onClick={() => moveColumn(selected, ci, -1)} aria-label="Move column left" title="Move left">←</button>
                          <button type="button" disabled={ci === all.length - 1} onClick={() => moveColumn(selected, ci, 1)} aria-label="Move column right" title="Move right">→</button>
                          <button type="button" disabled={all.length <= 1} onClick={() => patchProps(selected, { columns: all.filter((_, j) => j !== ci) })}>Remove column</button>
                        </div>
                      </details>
                    ))}
                    <button type="button" disabled={(sel.props?.columns ?? []).length >= 12} onClick={() => addColumn(selected)}>+ Add column</button>
                    <div className="b-pair">
                      <label>Min. rows<input type="number" min={0} max={200} value={sel.props?.minRows ?? ''} onChange={(e) => patchProps(selected, { minRows: num(e.target.value) })} /></label>
                      <label>Max. rows<input type="number" min={1} max={200} value={sel.props?.maxRows ?? ''} placeholder="200" onChange={(e) => patchProps(selected, { maxRows: num(e.target.value) })} /></label>
                    </div>
                    <p className="hint">People add rows as they need them. Calculated cells and totals update as they type, and the server works them out again when the form is submitted.</p>
                  </fieldset>
                )}

                {AUTOFILL_TYPES.includes(sel.type) && sel.props?.formula === undefined && lookupControls.length > 0 && (
                  <fieldset className="b-auto">
                    <legend>Auto-fill from a lookup</legend>
                    <label>Follows
                      <select value={sel.props?.lookupFrom ?? ''} onChange={(e) => patchProps(selected, { lookupFrom: e.target.value || undefined, lookupColumn: undefined })}>
                        <option value="">Not auto-filled (typed by the person)</option>
                        {lookupControls.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
                      </select>
                    </label>
                    {sel.props?.lookupFrom && (
                      <label>Shows column
                        <select value={sel.props?.lookupColumn ?? ''} onChange={(e) => patchProps(selected, { lookupColumn: e.target.value || undefined })}>
                          <option value="">Choose…</option>
                          {(tableOf(sel.props.lookupFrom)?.columns ?? []).filter((c) => c !== tableOf(sel.props!.lookupFrom)?.keyColumn).map((c) => <option key={c}>{c}</option>)}
                        </select>
                        <span className="hint">Read-only on the form. The value is taken from the spreadsheet when the form is submitted.</span>
                      </label>
                    )}
                  </fieldset>
                )}

                {isChoice(sel.type) && (
                  <>
                    <label>Options (one per line)
                      <textarea rows={5} value={(sel.options ?? []).join('\n')} onChange={(e) => patch(selected, { options: e.target.value.split('\n') })} />
                    </label>
                    {sel.type !== 'select' && <label className="check"><input type="checkbox" checked={!!sel.props?.inline} onChange={(e) => patchProps(selected, { inline: e.target.checked || undefined })} /><span>Show options side by side</span></label>}
                  </>
                )}

                {(TEXTY.includes(sel.type) || NUMERIC.includes(sel.type) || sel.type === 'select') && sel.type !== 'range' && sel.props?.formula === undefined && (
                  <label>{sel.type === 'select' ? 'Empty choice text' : 'Placeholder'}<input value={sel.props?.placeholder ?? ''} onChange={(e) => patchProps(selected, { placeholder: e.target.value || undefined })} /></label>
                )}
                <label>Help text<input value={sel.props?.helpText ?? ''} onChange={(e) => patchProps(selected, { helpText: e.target.value || undefined })} /></label>
                {sel.type !== 'grid' && sel.type !== 'sigpad' && sel.props?.formula === undefined && <label>Default value<input value={sel.props?.defaultValue ?? ''} placeholder={sel.type === 'checkbox' ? 'yes / no' : sel.type === 'multiselect' ? 'Option 1, Option 2' : sel.type === 'date' ? 'YYYY-MM-DD' : ''} onChange={(e) => patchProps(selected, { defaultValue: e.target.value || undefined })} /></label>}

                {(NUMERIC.includes(sel.type) || sel.type === 'multiselect') && (
                  <div className="b-pair">
                    <label>{sel.type === 'multiselect' ? 'Min. ticked' : 'Minimum'}<input type="number" value={sel.rules?.min ?? ''} onChange={(e) => patchRules(selected, { min: num(e.target.value) })} /></label>
                    <label>{sel.type === 'multiselect' ? 'Max. ticked' : 'Maximum'}<input type="number" value={sel.rules?.max ?? ''} onChange={(e) => patchRules(selected, { max: num(e.target.value) })} /></label>
                  </div>
                )}
                {NUMERIC.includes(sel.type) && sel.props?.formula === undefined && <label>Step<input type="number" min={0} step="any" value={sel.props?.step ?? ''} placeholder={sel.type === 'currency' ? '0.01' : '1'} onChange={(e) => patchProps(selected, { step: num(e.target.value) || undefined })} /></label>}
                {TEXTY.includes(sel.type) && sel.props?.formula === undefined && (
                  <>
                    <div className="b-pair">
                      <label>Min. length<input type="number" min={0} value={sel.rules?.minLength ?? ''} onChange={(e) => patchRules(selected, { minLength: num(e.target.value) })} /></label>
                      <label>Max. length<input type="number" min={1} value={sel.rules?.maxLength ?? ''} onChange={(e) => patchRules(selected, { maxLength: num(e.target.value) })} /></label>
                    </div>
                    {sel.type !== 'textarea' && <label>Pattern (regular expression)<input className="mono" value={sel.rules?.pattern ?? ''} placeholder="^[A-Z]{2}-\d{4}$" onChange={(e) => patchRules(selected, { pattern: e.target.value || undefined })} /></label>}

                  </>
                )}
              </>
            )}
            <button type="button" className="danger-outline" onClick={() => remove(selected)}>Remove this control</button>
            <details><summary className="small muted">Advanced</summary>
              <label>Key (internal name)<input className="mono" value={sel.key} onChange={(e) => patch(selected, { key: e.target.value })} /></label>
              <p className="hint">Changing the key of a control that is already in use makes it a different field for new requests.</p>
            </details>
          </div>
        ) : (
          <div className="b-palette">
            <strong>Add a control</strong>
            {PALETTE.map((g) => (
              <div key={g.group}>
                <p className="b-cap">{g.group}</p>
                <div className="b-chips">{g.items.map(([t, l]) => (
                  <button type="button" key={t} draggable onClick={() => add(t)} title="Click to add at the end, or drag onto the form"
                    onDragStart={(e) => { dragging.current = { type: t }; e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData('text/plain', l); }}
                    onDragEnd={endDrag}>+ {l}</button>
                ))}</div>
              </div>
            ))}
            <p className="hint">Click a control in the preview to edit it, drag it to move it, drag its right edge to resize, and use its ✕ to remove it. Drag a control from this list to put it exactly where you want it.</p>
          </div>
        )}
      </aside>
    </div>
    </div>
  );
}
