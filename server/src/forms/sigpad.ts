// A signature drawn with a stylus, finger or mouse ('sigpad' control). It is kept as pen strokes on a fixed
// 600 x 200 pad rather than as an image: a list of numbers can be checked completely, stays small, and is
// drawn as crisp vector lines on screen and in the PDF. client/src/sigpad.tsx has the same sigPathData().

export const SIG_W = 600;
export const SIG_H = 200;
const MAX_STROKES = 300;
const MAX_POINTS = 20000;

/** Each stroke is one pen-down to pen-up movement, flattened: [x0, y0, x1, y1, ...]. */
export interface SigValue { w: number; h: number; strokes: number[][] }

export function checkSignature(raw: unknown): { value: string | null } | { error: string } {
  const bad = { error: 'is not a valid drawn signature' };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad;
  const strokes = (raw as { strokes?: unknown }).strokes;
  if (!Array.isArray(strokes) || strokes.length > MAX_STROKES) return bad;
  let points = 0;
  const out: number[][] = [];
  for (const s of strokes) {
    if (!Array.isArray(s) || s.length % 2 !== 0) return bad;
    if (s.length === 0) continue;
    points += s.length / 2;
    if (points > MAX_POINTS) return { error: 'is too detailed - please clear it and sign again' };
    const stroke: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const n: unknown = s[i];
      if (typeof n !== 'number' || !Number.isFinite(n)) return bad;
      stroke.push(Math.round(Math.max(0, Math.min(i % 2 === 0 ? SIG_W : SIG_H, n)) * 10) / 10); // kept on the pad, one decimal
    }
    out.push(stroke);
  }
  if (out.length === 0) return { value: null };
  const value: SigValue = { w: SIG_W, h: SIG_H, strokes: out };
  return { value: JSON.stringify(value) };
}

/** SVG path data for the strokes, rounded through the midpoints between samples so the line is smooth. */
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

/** A stored value read back; null if it is not one (so callers can fall back to plain text). */
export function parseSignature(value: string | null): SigValue | null {
  try {
    const v = JSON.parse(value ?? '') as SigValue;
    return Array.isArray(v.strokes) && v.strokes.every((s) => Array.isArray(s) && s.length >= 2 && s.every((n) => typeof n === 'number')) ? v : null;
  } catch {
    return null;
  }
}
