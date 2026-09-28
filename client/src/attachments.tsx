// Documents an approver attached on a step. Shown to approvers and administrators, never to the submitter.
import { useRef, useState } from 'react';
import { ApiError, api, download, uploadFile } from './api';

export interface Attachment {
  attachmentId: number;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedBy?: string;
}

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.jpg,.jpeg,.png';

export const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Read-only list with a download button per file. `pathOf` gives the API path that serves one attachment. */
export function AttachmentList({ items, pathOf, onRemove, disabled }: {
  items: Attachment[];
  pathOf: (a: Attachment) => string;
  onRemove?: (a: Attachment) => void;
  disabled?: boolean;
}) {
  const [error, setError] = useState('');
  if (items.length === 0) return null;
  return (
    <div className="attachments">
      <p className="small muted" style={{ margin: '.5rem 0 .25rem' }}>Attached documents</p>
      <ul style={{ margin: 0, paddingLeft: '1.2rem' }}>
        {items.map((a) => (
          <li key={a.attachmentId}>
            <button type="button" className="link" onClick={() => { setError(''); download(pathOf(a), a.fileName).catch((e: Error) => setError(e.message)); }}>{a.fileName}</button>
            <span className="muted small"> · {fileSize(a.sizeBytes)}{a.uploadedBy ? ` · ${a.uploadedBy}` : ''}</span>
            {onRemove && <> <button type="button" className="link danger-link" disabled={disabled} onClick={() => onRemove(a)} aria-label={`Remove ${a.fileName}`}>Remove</button></>}
          </li>
        ))}
      </ul>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

/** The approver's own documents on an open step: add (one or several at once) and remove before deciding. */
export function AttachmentUploader({ requestStepId, requestId, items, max, disabled, onChange }: {
  requestStepId: number;
  requestId: number;
  items: Attachment[];
  max: number;
  disabled?: boolean;
  onChange: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    const list = [...files];
    const tooBig = list.find((f) => f.size > MAX_BYTES);
    if (tooBig) return setError(`"${tooBig.name}" is larger than 10 MB.`);
    if (items.length + list.length > max) return setError(`You can attach at most ${max} documents on this step.`);
    setBusy(true);
    try {
      for (const f of list) await uploadFile(`/approvals/${requestStepId}/attachments?name=${encodeURIComponent(f.name)}`, f);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The upload failed.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
      onChange();
    }
  };

  const remove = async (a: Attachment) => {
    setError('');
    setBusy(true);
    try {
      await api(`/approvals/${requestStepId}/attachments/${a.attachmentId}`, { method: 'DELETE' });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove it.');
    } finally {
      setBusy(false);
      onChange();
    }
  };

  return (
    <div className="field">
      <label htmlFor="attach">Attach documents</label>
      <AttachmentList items={items} pathOf={(a) => `/approvals/requests/${requestId}/attachments/${a.attachmentId}`} onRemove={(a) => void remove(a)} disabled={busy || disabled} />
      {items.length < max && (
        <input id="attach" ref={input} type="file" multiple accept={ACCEPT} disabled={busy || disabled} onChange={(e) => void add(e.target.files)} style={{ marginTop: '.4rem' }} />
      )}
      <p className="hint">{busy ? 'Uploading…' : `Optional. PDF, Word, Excel, PowerPoint, text or images, up to 10 MB each (${items.length} of ${max}). Only approvers and administrators can see them.`}</p>
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}
