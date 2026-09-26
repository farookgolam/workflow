// Signature pad: sign with a stylus, a finger or the mouse. Pointer events cover all three, and
// touch-action: none (styles.css) stops the page scrolling while someone signs on a touch screen.
// The pen strokes are kept on a fixed 600 x 200 pad - see server/src/forms/sigpad.ts, which checks them.
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export const SIG_W = 600;
export const SIG_H = 200;
export interface SigValue { w: number; h: number; strokes: number[][] }

/** Same as the server's: SVG path data, rounded through the midpoints between samples so the line is smooth. */
export function sigPathData(strokes: number[][]): string {
  return strokes
    .map((s) => {
      if (s.length === 2) return `M${s[0]} ${s[1]}l0.1 0`; // a dot
      let d = `M${s[0]} ${s[1]}`;
      for (let i = 2; i < s.length - 2; i += 2) d += `Q${s[i]} ${s[i + 1]} ${(s[i] + s[i + 2]) / 2} ${(s[i + 1] + s[i + 3]) / 2}`;
      return `${d}L${s[s.length - 2]} ${s[s.length - 1]}`;
    })
    .join('');
}

export function parseSignature(value: string | null | undefined): SigValue | null {
  try {
    const v = JSON.parse(value ?? '') as SigValue;
    return Array.isArray(v.strokes) && v.strokes.every((s) => Array.isArray(s) && s.length >= 2 && s.every((n) => typeof n === 'number')) ? v : null;
  } catch { return null; }
}

/** Read-only drawing of a stored signature. */
export function SignatureImage({ value, label }: { value: string; label?: string }) {
  const sig = parseSignature(value);
  if (!sig) return <>—</>;
  return (
    <svg className="sig-image" viewBox={`0 0 ${sig.w || SIG_W} ${sig.h || SIG_H}`} role="img" aria-label={label ?? 'Signature'}>
      <path d={sigPathData(sig.strokes)} />
    </svg>
  );
}

/** `value` is the JSON text of a SigValue ('' = not signed). */
export function SignaturePad({ id, value, disabled, invalid, describedBy, label, onChange }: { id: string; value: string; disabled?: boolean; invalid?: boolean; describedBy?: string; label: string; onChange(v: string): void }) {
  const strokes = parseSignature(value)?.strokes ?? [];
  const [current, setCurrent] = useState<number[] | null>(null); // the stroke being drawn
  const drawing = useRef<number[] | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  const point = (e: ReactPointerEvent): [number, number] => {
    const box = svg.current!.getBoundingClientRect();
    const round = (n: number) => Math.round(n * 10) / 10;
    return [round(Math.max(0, Math.min(SIG_W, ((e.clientX - box.left) / box.width) * SIG_W))), round(Math.max(0, Math.min(SIG_H, ((e.clientY - box.top) / box.height) * SIG_H)))];
  };
  const down = (e: ReactPointerEvent) => {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    svg.current!.setPointerCapture(e.pointerId);
    drawing.current = point(e);
    setCurrent(drawing.current);
  };
  const move = (e: ReactPointerEvent) => {
    const s = drawing.current;
    if (!s) return;
    const [x, y] = point(e);
    if (Math.hypot(x - s[s.length - 2], y - s[s.length - 1]) < 1.5) return; // skip samples that barely moved
    drawing.current = [...s, x, y];
    setCurrent(drawing.current);
  };
  const up = () => {
    const s = drawing.current;
    if (!s) return;
    drawing.current = null;
    setCurrent(null);
    onChange(JSON.stringify({ w: SIG_W, h: SIG_H, strokes: [...strokes, s] } satisfies SigValue));
  };

  const all = current ? [...strokes, current] : strokes;
  return (
    <div className={`sigpad${disabled ? ' disabled' : ''}${invalid ? ' invalid' : ''}`}>
      <svg ref={svg} id={id} viewBox={`0 0 ${SIG_W} ${SIG_H}`} role="img" aria-label={`${label}: ${all.length ? 'signed' : 'not signed yet'}`} aria-describedby={describedBy}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <line x1="24" y1={SIG_H - 42} x2={SIG_W - 24} y2={SIG_H - 42} className="sig-line" />
        <path d={sigPathData(all)} />
      </svg>
      {all.length === 0 && <span className="sig-hint" aria-hidden="true">Sign here with your finger, a stylus or the mouse</span>}
      <div className="sig-tools">
        <button type="button" className="link" disabled={disabled || strokes.length === 0} onClick={() => onChange(strokes.length > 1 ? JSON.stringify({ w: SIG_W, h: SIG_H, strokes: strokes.slice(0, -1) }) : '')}>Undo</button>
        <button type="button" className="link" disabled={disabled || strokes.length === 0} onClick={() => onChange('')}>Clear</button>
      </div>
    </div>
  );
}
