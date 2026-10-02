// The sign-off strip: one box per approval step, like the row of approval boxes at the foot of a paper form.
// Each box says which step it is, who signs (or signed) it, and when. Colours: green signed, yellow with someone now,
// purple sent back, red rejected, hatched not reached yet.
import { waitedFor } from './dates';

export interface SignOffStep {
  stepOrder: number;
  /** the step's name; null when the viewer may not know it yet */
  name: string | null;
  status: string;
  approver: string | null;
  activatedAt?: string | null;
  actedAt?: string | null;
}

const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const TONE: Record<string, string> = { Approved: 'done', Active: 'now', Returned: 'back', Rejected: 'no' };

/**
 * `mine`: the step the viewer is deciding (it reads "With you"). `toMe`: the viewer is the submitter, so a step that
 * sent the request back reads "Sent back to you". `big`: the strip under a page title rather than in a list.
 */
export function SignOff({ steps, big, mine, toMe }: { steps: SignOffStep[]; big?: boolean; mine?: number; toMe?: boolean }) {
  if (steps.length === 0) return null;
  return (
    <div className={`strip${big ? ' big' : ''}`} role="list" aria-label="Approval steps" style={big ? undefined : { maxWidth: `${steps.length * 16}rem` }}>
      {steps.map((s) => {
        const [main, sub] =
          s.status === 'Approved' ? [s.approver ?? 'Approved', day(s.actedAt)]
          : s.status === 'Active' ? [s.stepOrder === mine ? 'With you' : `With ${s.approver ?? 'the approver'}`, s.activatedAt ? `for ${waitedFor(s.activatedAt)}` : '']
          : s.status === 'Returned' ? [toMe ? 'Sent back to you' : 'Sent back for changes', s.approver ? `by ${s.approver}` : '']
          : s.status === 'Rejected' ? ['Rejected', [s.approver && `by ${s.approver}`, day(s.actedAt)].filter(Boolean).join(', ')]
          : s.status === 'NotReached' ? ['Not reached', '']
          : s.status === 'Cancelled' ? ['Cancelled', '']
          : [s.approver ?? 'To be chosen', ''];
        return (
          <div key={s.stepOrder} role="listitem" className={`s-${TONE[s.status] ?? 'later'}`}>
            <small>Step {s.stepOrder}{s.name ? `, ${s.name}` : ''}</small>
            <b>{main}</b>
            {sub && <span>{sub}</span>}
          </div>
        );
      })}
    </div>
  );
}
