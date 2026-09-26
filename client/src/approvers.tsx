// "Who does this go to next?" - shown to the submitter (for step 1) and to each approver (for the step after theirs).
// A fixed step just says who it goes to. A chosen step asks the person handing on to pick someone: from the step's
// lookup file (whether or not the person has an account yet - the columns the administrator chose are filled in,
// read-only, for whoever is picked), or from everyone with the Approver role.
export interface ApproverOption { userId: number | null; displayName: string; email: string; listKey?: string; info?: Record<string, string> }
export interface StepHandOff {
  stepOrder: number; name: string;
  mode: 'fixed' | 'chosen';
  approver: ApproverOption | null; // the fixed approver; null on a chosen step
  candidates: ApproverOption[]; // who may be chosen; empty on a fixed step
  list?: { name: string; keyColumn: string; nameColumn: string | null; columns: string[] } | null; // a chosen step's lookup file
}

/** What identifies a choice in the drop-down: the spreadsheet row for a listed step, the user otherwise. */
export const optionId = (step: StepHandOff, u: ApproverOption): string => (step.list ? `key:${u.listKey ?? ''}` : `user:${u.userId}`);
/** The part of the request body that names the choice; nothing for a fixed step. */
export function choicePayload(step: StepHandOff | null | undefined, choice: string | null, prefix: 'first' | 'next'): Record<string, unknown> {
  if (!step || step.mode !== 'chosen' || choice === null) return {};
  return choice.startsWith('key:') ? { [`${prefix}ApproverKey`]: choice.slice(4) } : { [`${prefix}ApproverUserId`]: Number(choice.slice(5)) };
}
/** A chosen step has no default: somebody must be picked before sending. */
export const needsChoice = (step: StepHandOff | null | undefined, choice: string | null): boolean =>
  step?.mode === 'chosen' && !step.candidates.some((c) => optionId(step, c) === choice);

export function NextApproverPicker({ id, step, totalSteps, value, error, disabled, when = 'as soon as you submit', onChange }: {
  id: string; step: StepHandOff; totalSteps?: number; value: string | null; error?: string; disabled?: boolean; when?: string; onChange(choice: string): void;
}) {
  const legend = <legend>Send to - step {step.stepOrder}{totalSteps ? ` of ${totalSteps}` : ''}: {step.name}</legend>;
  if (step.mode === 'fixed') {
    return (
      <fieldset className="field handoff" disabled={disabled}>
        {legend}
        <div className="field"><label htmlFor={id}>Approver</label><input id={id} value={step.approver?.displayName ?? ''} readOnly tabIndex={-1} /></div>
        <p className="hint">They will be emailed a link {when}.</p>
      </fieldset>
    );
  }

  const list = step.list;
  // a listed person reads "key - name" when the name column says more than the key; two people can share a name, the email tells them apart
  const label = (u: ApproverOption) => {
    if (list) return list.nameColumn && u.displayName !== u.listKey ? `${u.listKey} - ${u.displayName}` : u.displayName;
    return step.candidates.some((c) => c !== u && c.displayName === u.displayName) ? `${u.displayName} (${u.email})` : u.displayName;
  };
  const chosen = step.candidates.find((c) => optionId(step, c) === value);
  const columns = list?.columns ?? [];
  return (
    <fieldset className="field handoff" disabled={disabled}>
      {legend}
      <div className="handoff-grid">
        <div className="field">
          <label htmlFor={id}>{list ? list.keyColumn : 'Approver'}<em className="req"> *</em></label>
          <select id={id} value={chosen ? value! : ''} aria-invalid={!!error} disabled={step.candidates.length === 0} onChange={(e) => e.target.value && onChange(e.target.value)}>
            <option value="">Choose…</option>
            {step.candidates.map((u) => <option key={optionId(step, u)} value={optionId(step, u)}>{label(u)}</option>)}
          </select>
        </div>
        {/* filled in from the spreadsheet row of whoever is chosen */}
        {columns.map((c) => (
          <div className="field autofilled" key={c}>
            <label htmlFor={`${id}-${c}`}>{c}</label>
            <input id={`${id}-${c}`} value={chosen?.info?.[c] ?? ''} readOnly tabIndex={-1} />
          </div>
        ))}
      </div>
      <p className="hint">
        {step.candidates.length === 0
          ? `Nobody ${list ? `in the "${list.name}" list ` : ''}can receive this step. Ask an administrator to complete ${list ? 'the list' : 'the approvers'}.`
          : `Choose who approves this step${list ? ` from the "${list.name}" list` : ''}. They will be emailed a link ${when}.`}
      </p>
      {error && <p className="field-error" role="alert">{error}</p>}
    </fieldset>
  );
}
