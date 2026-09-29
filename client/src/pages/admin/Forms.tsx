import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api';
import { type FieldDef } from '../../fields';
import { FormBuilder, cleanFields, fieldProblems } from './FormBuilder';
import { ChainPreview, approverProblem, toChainStep, type ChosenFrom, type StepDef } from './ChainPreview';
import { useAction, useLoad, type FormRow, type UserRow } from '../../hooks';

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);

export function AdminForms() {
  const navigate = useNavigate();
  const { data, error, reload } = useLoad<{ forms: FormRow[] }>('/admin/forms');
  const act = useAction();
  const del = useAction();
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<FormRow | null>(null);

  const remove = (f: FormRow) =>
    del.run(async () => {
      const r = await api<{ mode: 'deleted' | 'archived'; requests: number; inProgress: number }>(`/admin/forms/${f.formId}`, { method: 'DELETE' });
      setDeleting(null);
      reload();
      return r.mode === 'deleted'
        ? `"${f.name}" was deleted.`
        : `"${f.name}" was removed from the repository. Its ${r.requests} request(s) and their PDFs are kept${r.inProgress ? `; ${r.inProgress} still in progress will carry on to a decision` : ''}.`;
    });

  const create = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      const r = await api<{ formId: number }>('/admin/forms', { method: 'POST', body: { name: name.trim(), slug: slugify(name), fields: [{ key: 'title', label: 'Title', type: 'text', required: true }] } });
      navigate(`/admin/forms/${r.formId}`);
    });
  };
  return (
    <div className="stack">
      <h1>Forms &amp; approval chains</h1>
      {del.error && <p className="notice bad" role="alert">{del.error}</p>}
      {del.ok && <p className="notice ok" role="status">{del.ok}</p>}
      <section className="card">
        {error ? <p className="notice bad">{error}</p> : !data ? <p className="muted">Loading…</p> : data.forms.length === 0 ? <p className="muted">No forms yet.</p> : (
          <table>
            <thead><tr><th>Form</th><th>Status</th><th className="num">Steps</th><th>Chain version</th><th className="num">Requests</th><th /></tr></thead>
            <tbody>{data.forms.map((f) => (
              <tr key={f.formId}>
                <td><Link to={`/admin/forms/${f.formId}`}>{f.name}</Link></td>
                <td>{f.isActive ? 'Active' : <span className="muted">Inactive</span>}</td>
                <td className="num">{f.steps || <span className="field-error">none</span>}</td>
                <td>{f.chainVersion ? `v${f.chainVersion}` : '—'}</td>
                <td className="num">{f.requests}</td>
                <td className="row-actions"><button className="link danger-link" disabled={del.busy} onClick={() => { del.clear(); setDeleting(f); }}>Delete</button></td>
              </tr>))}
            </tbody>
          </table>
        )}
      </section>
      {deleting && (
        <section className="card reject-box" role="alertdialog" aria-labelledby="del-title">
          <h2 id="del-title">Delete "{deleting.name}"?</h2>
          {deleting.requests === 0 ? (
            <p>This form has no requests, so it will be <strong>deleted permanently</strong> together with its fields and approval chain. This cannot be undone.</p>
          ) : (
            <p>This form has <strong>{deleting.requests} request(s)</strong>. It will be removed from this list and from submitters, and nobody can start it again. The existing requests, their audit trail and their PDFs are <strong>kept</strong>, and any request still in progress carries on to a decision. This cannot be undone here.</p>
          )}
          <p className="muted small">Only want to stop new submissions for a while? Open the form and untick <strong>Active</strong> instead.</p>
          <div className="actions">
            <button className="danger" disabled={del.busy} onClick={() => void remove(deleting)}>{del.busy ? 'Deleting…' : 'Delete form'}</button>
            <button disabled={del.busy} onClick={() => setDeleting(null)}>Cancel</button>
          </div>
        </section>
      )}
      <form className="card" onSubmit={create}>
        <h2>New form</h2>
        {act.error && <p className="notice bad">{act.error}</p>}
        <div className="actions">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Form name, e.g. Travel Request" style={{ maxWidth: 360 }} required />
          <button className="primary" disabled={act.busy || !slugify(name)}>Create and configure</button>
        </div>
        <p className="hint">Submitters only see a form once it has an approval chain.</p>
      </form>
      <ImportHtmlForm />
    </div>
  );
}

interface ImportDraft { name: string; description: string | null; fields: FieldDef[]; warnings: string[] }

/** Upload (or paste) an existing HTML form -> review the detected fields -> create the form -> add approval steps in the editor. */
function ImportHtmlForm() {
  const navigate = useNavigate();
  const parse = useAction();
  const save = useAction();
  const [pasted, setPasted] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [draft, setDraft] = useState<ImportDraft | null>(null);

  const readDraft = (html: string) =>
    parse.run(async () => {
      const d = await api<ImportDraft>('/admin/forms/import-html', { method: 'POST', body: { html } });
      setDraft({ ...d, fields: d.fields.map((f) => ({ ...f, options: f.options ?? null, rules: f.rules ?? null })) });
    });
  const onFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 850_000) return void parse.run(async () => { throw new Error('too big'); }); // surfaces the generic error; the server enforces the real limit
    void file.text().then(readDraft);
  };
  const create = () =>
    save.run(async () => {
      if (!draft) return;
      const r = await api<{ formId: number }>('/admin/forms', {
        method: 'POST',
        body: { name: draft.name.trim(), slug: slugify(draft.name), ...(draft.description?.trim() ? { description: draft.description.trim() } : {}), fields: cleanFields(draft.fields) },
      });
      navigate(`/admin/forms/${r.formId}`); // the editor is where approval steps are added
    });

  if (draft) {
    return (
      <section className="card card-active">
        <h2>Review the imported form</h2>
        <p className="muted">Nothing is saved yet. Check the labels, types and required ticks, remove anything you do not want, then create the form. You add the approval steps on the next screen.</p>
        {draft.warnings.length > 0 && (
          <div className="notice" style={{ marginBottom: '1rem' }}>
            <strong>Worth checking</strong>
            <ul style={{ margin: '.4rem 0 0', paddingLeft: '1.2rem' }}>{draft.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        )}
        {save.error && <p className="notice bad" role="alert">{save.error}</p>}
        <div className="field"><label htmlFor="imp-name">Form name</label><input id="imp-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
        <div className="field"><label htmlFor="imp-desc">Description</label><textarea id="imp-desc" rows={2} value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
        <p className="small muted" style={{ marginBottom: '.4rem' }}>{draft.fields.length} field(s) detected</p>
        <FormBuilder fields={draft.fields} onChange={(fields) => setDraft({ ...draft, fields })} />
        {fieldProblems(draft.fields).map((p) => <p key={p} className="field-error">{p}</p>)}
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button className="primary" disabled={save.busy || !slugify(draft.name) || draft.fields.length === 0 || fieldProblems(draft.fields).length > 0} onClick={() => void create()}>Create form and add approval steps</button>
          <button disabled={save.busy} onClick={() => setDraft(null)}>Discard</button>
        </div>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Import an HTML form</h2>
      <p className="muted">Already have the form as a web page? Upload the <code>.html</code> file and its inputs, drop-downs, radio buttons, tick boxes and text areas become fields here. The file is only read for its fields - scripts and styling in it are ignored.</p>
      {parse.error && <p className="notice bad" role="alert">{parse.error === 'Something went wrong.' ? 'That file could not be read, or it is larger than 1 MB.' : parse.error}</p>}
      <div className="actions">
        <label className="file-btn">
          <input type="file" accept=".html,.htm,text/html" disabled={parse.busy} onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
          <span>{parse.busy ? 'Reading…' : 'Choose HTML file…'}</span>
        </label>
        <button type="button" className="link" onClick={() => setShowPaste((v) => !v)}>{showPaste ? 'Hide paste box' : 'or paste the HTML instead'}</button>
      </div>
      {showPaste && (
        <div style={{ marginTop: '.75rem' }}>
          <textarea rows={6} className="mono" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="<form> … </form>" aria-label="HTML source of the form" />
          <div className="actions"><button className="primary" disabled={parse.busy || !pasted.trim()} onClick={() => void readDraft(pasted)}>Read fields</button></div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------
interface FormDetail { form: { formId: number; name: string; slug: string; description: string | null; isActive: boolean; submittersSeeComments: boolean }; fields: FieldDef[]; chainVersion: number | null; steps: StepDef[] }

const numOrNull = (v: string) => (v === '' ? null : Math.max(1, Math.floor(Number(v))));

export function AdminFormEditor() {
  const { formId } = useParams();
  const { data, error, reload } = useLoad<FormDetail>(`/admin/forms/${formId}`);
  const users = useLoad<{ users: UserRow[] }>('/admin/users').data?.users ?? [];
  const approvers = users.filter((u) => u.isActive && (u.roles.includes('Approver') || u.roles.includes('Admin')));
  const tables = useLoad<{ lookups: { lookupId: number; name: string; keyColumn: string; columns: string[]; rows: number }[] }>('/admin/lookups').data?.lookups ?? [];

  const [details, setDetails] = useState<FormDetail['form'] | null>(null);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [steps, setSteps] = useState<StepDef[]>([]);
  const aDetails = useAction(), aFields = useAction(), aChain = useAction();
  // the chain's "Preview & test": null while designing, otherwise the stage it opened at (0 = the submission, n = step n)
  const [preview, setPreview] = useState<number | null>(null);
  const [previewStage, setPreviewStage] = useState(0);
  const openPreview = (stage: number) => { setPreview(stage); setPreviewStage(stage); };

  useEffect(() => { if (data) { setDetails(data.form); setFields(data.fields); setSteps(data.steps); } }, [data]);

  if (error) return <p className="notice bad">{error}</p>;
  if (!data || !details) return <p className="muted center">Loading…</p>;
  const chooser = (i: number) => (i === 0 ? 'the submitter' : `the approver of step ${i}`);
  const patchStep = (i: number, p: Partial<StepDef>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const Msg = ({ a }: { a: ReturnType<typeof useAction> }) => <>{a.error && <p className="notice bad" role="alert">{a.error}</p>}{a.ok && <p className="notice ok" role="status">{a.ok}</p>}</>;

  return (
    <div className="stack">
      <div><p className="eyebrow"><Link to={`/admin/forms`}>Forms</Link></p><h1>{data.form.name}</h1></div>

      <section className="card">
        <h2>Details</h2>
        <Msg a={aDetails} />
        <div className="field"><label htmlFor="fn">Name</label><input id="fn" value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} /></div>
        <div className="field"><label htmlFor="fd">Description</label><textarea id="fd" rows={2} value={details.description ?? ''} onChange={(e) => setDetails({ ...details, description: e.target.value })} /></div>
        <div className="field"><label className="check"><input type="checkbox" checked={details.isActive} onChange={(e) => setDetails({ ...details, isActive: e.target.checked })} /><span>Active (submitters can start new requests)</span></label></div>
        <div className="field"><label className="check"><input type="checkbox" checked={details.submittersSeeComments} onChange={(e) => setDetails({ ...details, submittersSeeComments: e.target.checked })} /><span>Submitters can see approver comments and fields in the portal</span></label></div>
        <button className="primary" disabled={aDetails.busy} onClick={() => void aDetails.run(async () => { await api(`/admin/forms/${formId}`, { method: 'PATCH', body: { name: details.name, description: details.description ?? '', isActive: details.isActive, submittersSeeComments: details.submittersSeeComments } }); reload(); return 'Details saved.'; })}>Save details</button>
      </section>

      <section className="card">
        <h2>Submission fields</h2>
        <Msg a={aFields} />
        <FormBuilder fields={fields} onChange={setFields} />
        {fieldProblems(fields).map((p) => <p key={p} className="field-error">{p}</p>)}
        <p className="hint">This preview is the layout submitters will see. Removing a control retires it: existing requests keep the data they were submitted with.</p>
        <button className="primary" disabled={aFields.busy || fields.length === 0 || fieldProblems(fields).length > 0} onClick={() => void aFields.run(async () => { await api(`/admin/forms/${formId}/fields`, { method: 'PUT', body: { fields: cleanFields(fields) } }); reload(); return 'Fields saved.'; })}>Save fields</button>
      </section>

      <section className="card">
        <h2>Approval chain {data.chainVersion && <span className="tag">v{data.chainVersion}</span>}</h2>
        <Msg a={aChain} />
        <div className="seg b-mode" role="group" aria-label="Approval chain mode">
          <button type="button" className={preview === null ? 'on' : ''} aria-pressed={preview === null} onClick={() => setPreview(null)}>Design</button>
          <button type="button" className={preview !== null ? 'on' : ''} aria-pressed={preview !== null} disabled={steps.length === 0} onClick={() => openPreview(0)}>Preview &amp; test</button>
        </div>
        {preview !== null ? (
          <>
            <ChainPreview steps={steps} fields={fields} users={users} startAt={preview} onStage={setPreviewStage} />
            <div className="actions" style={{ marginTop: '1rem' }}>
              <button type="button" onClick={() => { setPreview(null); requestAnimationFrame(() => document.getElementById(`step-def-${previewStage - 1}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })); }}>
                {previewStage >= 1 && previewStage <= steps.length ? `Edit step ${previewStage} in Design` : 'Back to Design'}
              </button>
            </div>
          </>
        ) : (<>
        {steps.map((s, i) => (
          <div className="step-def" key={i} id={`step-def-${i}`}>
            <div className="prev-head"><strong>Step {i + 1}</strong>
              <span className="def-btns">
                <button type="button" onClick={() => openPreview(i + 1)} title="See and try this step as its approver would">Preview &amp; test</button>
                <button type="button" disabled={i === 0} onClick={() => setSteps((x) => { const n = [...x]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; return n; })} aria-label="Move step up">↑</button>
                <button type="button" disabled={i === steps.length - 1} onClick={() => setSteps((x) => { const n = [...x]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; return n; })} aria-label="Move step down">↓</button>
                <button type="button" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} aria-label="Remove step">✕</button>
              </span>
            </div>
            <div className="grid2">
              <label>Step name<input value={s.name} onChange={(e) => patchStep(i, { name: e.target.value })} placeholder="e.g. Line manager" /></label>
            </div>
            <fieldset className="b-auto step-group">
              <legend>Who approves this step</legend>
              <label className="check plain"><input type="radio" name={`who-${i}`} checked={!s.chosen} onChange={() => patchStep(i, { chosen: null })} /><span>Always the same person</span></label>
              {!s.chosen && (
                <div className="grid2" style={{ margin: '.3rem 0 .6rem 1.6rem' }}>
                  <label>Approver<select value={s.approverUserId ?? ''} onChange={(e) => patchStep(i, { approverUserId: e.target.value ? Number(e.target.value) : null })}><option value="">Choose…</option>{approvers.map((u) => <option key={u.userId} value={u.userId}>{u.displayName}</option>)}</select></label>
                </div>
              )}
              <label className="check plain"><input type="radio" name={`who-${i}`} checked={!!s.chosen} onChange={() => patchStep(i, { approverUserId: null, chosen: { lookupId: null, emailColumn: null, nameColumn: null, columns: [] } })} /><span>Chosen by {chooser(i)}, when they {i === 0 ? 'submit' : 'approve'}</span></label>
              {s.chosen && (() => {
                const c = s.chosen;
                const table = tables.find((t) => t.lookupId === c.lookupId);
                const setChosen = (p: Partial<ChosenFrom>) => patchStep(i, { chosen: { ...c, ...p } });
                const guess = (t: typeof table, re: RegExp) => t?.columns.find((col) => re.test(col)) ?? null;
                return (
                  <div className="stack" style={{ margin: '.3rem 0 0 1.6rem', gap: '.6rem' }}>
                    <label>From
                      <select value={c.lookupId ?? ''} onChange={(e) => {
                        const t = tables.find((x) => x.lookupId === Number(e.target.value));
                        setChosen(t ? { lookupId: t.lookupId, emailColumn: guess(t, /e-?mail/i), nameColumn: guess(t, /name|secretary|principal|manager|approver/i), columns: [] } : { lookupId: null, emailColumn: null, nameColumn: null, columns: [] });
                      }}>
                        <option value="">Everyone with the Approver role</option>
                        {tables.map((t) => <option key={t.lookupId} value={t.lookupId}>The lookup file "{t.name}" ({t.rows} rows)</option>)}
                      </select>
                    </label>
                    {table && (
                      <>
                        <div className="grid2">
                          <label>Column with their email<em className="req"> *</em>
                            <select value={c.emailColumn ?? ''} onChange={(e) => setChosen({ emailColumn: e.target.value || null })}><option value="">Choose…</option>{table.columns.map((col) => <option key={col}>{col}</option>)}</select>
                          </label>
                          <label>Column with their name
                            <select value={c.nameColumn ?? ''} onChange={(e) => setChosen({ nameColumn: e.target.value || null })}><option value="">The key column ({table.keyColumn})</option>{table.columns.filter((col) => col !== table.keyColumn).map((col) => <option key={col}>{col}</option>)}</select>
                          </label>
                        </div>
                        <div>
                          <span className="small muted">Also show, filled in, beside the chosen person:</span>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.3rem 1rem', marginTop: '.2rem' }}>
                            {table.columns.filter((col) => col !== table.keyColumn).map((col) => (
                              <label key={col} className="check plain"><input type="checkbox" checked={c.columns.includes(col)} disabled={!c.columns.includes(col) && c.columns.length >= 8}
                                onChange={(e) => setChosen({ columns: e.target.checked ? [...c.columns, col] : c.columns.filter((x) => x !== col) })} /><span>{col}</span></label>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                    <p className="hint" style={{ margin: 0 }}>
                      {i === 0 ? 'The submitter' : `The approver of step ${i}`} picks {table ? <>a row of <strong>{table.name}</strong> by its <strong>{table.keyColumn}</strong></> : 'one of the approvers'} {i === 0 ? 'before submitting' : 'when approving'}, and that person receives this step.
                      {table && ' Someone in the file who has no account yet gets one (with the Approver role) when they are chosen, and sets their key at first sign-in.'} Nobody can choose themselves or the submitter.
                    </p>
                  </div>
                );
              })()}
              {approverProblem(s) && <p className="field-error" style={{ margin: '.4rem 0 0' }}>{approverProblem(s)}</p>}
            </fieldset>
            <fieldset className="b-auto step-group">
              <legend>Reminders and escalation</legend>
              <div className="grid2">
              <label>Remind after (days)<input type="number" min={1} value={s.reminderAfterDays ?? ''} onChange={(e) => patchStep(i, { reminderAfterDays: numOrNull(e.target.value) })} /></label>
              <label>Then repeat every (days)<input type="number" min={1} value={s.reminderRepeatDays ?? ''} onChange={(e) => patchStep(i, { reminderRepeatDays: numOrNull(e.target.value) })} /></label>
              <label>Escalate after (days)<input type="number" min={1} value={s.escalateAfterDays ?? ''} onChange={(e) => patchStep(i, { escalateAfterDays: numOrNull(e.target.value) })} /></label>
              <label>Escalate to<select value={s.escalateToUserId ?? ''} onChange={(e) => patchStep(i, { escalateToUserId: e.target.value ? Number(e.target.value) : null })}><option value="">Administrators</option>{users.filter((u) => u.isActive).map((u) => <option key={u.userId} value={u.userId}>{u.displayName}</option>)}</select></label>
              </div>
            </fieldset>
          </div>
        ))}
        <div className="actions">
          <button type="button" onClick={() => setSteps((x) => [...x, { name: '', approverUserId: null, chosen: null, reminderAfterDays: null, reminderRepeatDays: null, escalateAfterDays: null, escalateToUserId: null }])}>+ Add step</button>
          <button className="primary" disabled={aChain.busy || steps.length === 0 || steps.some((s) => !!approverProblem(s) || !s.name.trim())}
            onClick={() => void aChain.run(async () => {
              const r = await api<{ version: number }>(`/admin/forms/${formId}/chain`, { method: 'PUT', body: { steps: steps.map(toChainStep) } });
              reload();
              return `Published as version ${r.version}. Requests already in progress keep the chain they started with.`;
            })}>Publish chain</button>
        </div>
        </>)}
      </section>

    </div>
  );
}
