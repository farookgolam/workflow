// A customer administrator's own settings: how the portal looks, who may register, what its emails
// are sent as, and where it archives. Anything left blank inherits the server default.
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useAction, useLoad } from '../../hooks';

export interface TenantSettings {
  brandName: string | null;
  brandColor: string | null;
  logoDataUrl: string | null;
  allowedEmailDomains: string | null;
  firstLoginEmailVerification: boolean | null;
  mailFromName: string | null;
  mailFromEmail: string | null;
  emailShowDetails: boolean | null;
  effective: { allowedDomains: string[]; verifyEmail: boolean; mailFrom: string };
}

const MAX_LOGO_BYTES = 300_000;

/** Empty input -> null ("inherit the server default"), which is not the same as an empty value. */
const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

export function SettingsForm({ settings, save, title }: { settings: TenantSettings; save(patch: Record<string, unknown>): Promise<string | void>; title?: string }) {
  const act = useAction();
  const [brandName, setBrandName] = useState('');
  const [brandColor, setBrandColor] = useState('');
  const [logo, setLogo] = useState<string | null>(null);
  const [domains, setDomains] = useState('');
  const [verify, setVerify] = useState<'inherit' | 'on' | 'off'>('inherit');
  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [showDetails, setShowDetails] = useState(true);
  const [logoError, setLogoError] = useState('');

  useEffect(() => {
    setBrandName(settings.brandName ?? '');
    setBrandColor(settings.brandColor ?? '');
    setLogo(settings.logoDataUrl);
    setDomains(settings.allowedEmailDomains ?? '');
    setVerify(settings.firstLoginEmailVerification === null ? 'inherit' : settings.firstLoginEmailVerification ? 'on' : 'off');
    setFromName(settings.mailFromName ?? '');
    setFromEmail(settings.mailFromEmail ?? '');
    setShowDetails(settings.emailShowDetails !== false);
  }, [settings]);

  const chooseLogo = (file: File | undefined) => {
    setLogoError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) return setLogoError('Choose an image file.');
    if (file.size > MAX_LOGO_BYTES) return setLogoError('That image is too large - keep it under 300 KB.');
    const reader = new FileReader();
    reader.onload = () => setLogo(String(reader.result));
    reader.readAsDataURL(file);
  };

  const submit = () =>
    act.run(async () => {
      const patch: Record<string, unknown> = {
        brandName: orNull(brandName),
        brandColor: orNull(brandColor),
        logoDataUrl: logo,
        allowedEmailDomains: orNull(domains),
        firstLoginEmailVerification: verify === 'inherit' ? null : verify === 'on',
        mailFromName: orNull(fromName),
        mailFromEmail: orNull(fromEmail),
        emailShowDetails: showDetails ? null : false,
      };
      // only send the secret when something was typed: an empty box means "leave it as it is"
      return (await save(patch)) || 'Settings saved.';
    });

  return (
    <div className="stack">
      {title && <h2>{title}</h2>}
      {act.error && <p className="notice error">{act.error}</p>}
      {act.ok && <p className="notice">{act.ok}</p>}

      <section className="card stack">
        <h3>Branding</h3>
        <p className="muted">Shown on the sign-in page and in the portal header. Leave blank to use the organisation's name.</p>
        <div className="field">
          <label htmlFor="brandName">Display name</label>
          <input id="brandName" value={brandName} maxLength={200} onChange={(e) => setBrandName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="brandColor">Accent colour</label>
          <input id="brandColor" type="color" className="color" value={brandColor || '#2563eb'} onChange={(e) => setBrandColor(e.target.value)} />
          {brandColor && <button type="button" className="link" onClick={() => setBrandColor('')}>Use the default</button>}
        </div>
        <div className="field">
          <label htmlFor="logo">Logo</label>
          {logo && <img src={logo} alt="" style={{ maxHeight: 48, display: 'block', marginBottom: 8 }} />}
          <input id="logo" type="file" accept="image/*" onChange={(e) => chooseLogo(e.target.files?.[0])} />
          {logo && <button type="button" className="link" onClick={() => setLogo(null)}>Remove the logo</button>}
          {logoError && <p className="field-error">{logoError}</p>}
          <p className="hint">Shown on the sign-in page and at the top of every page of the approved and rejected PDFs. Use a PNG or JPG for the PDFs (other image types appear on screen only; the PDF then shows the name alone).</p>
        </div>
      </section>

      <section className="card stack">
        <h3>Who can register</h3>
        <div className="field">
          <label htmlFor="domains">Allowed email domains</label>
          <input id="domains" value={domains} placeholder="acme.com, acme.co.uk" onChange={(e) => setDomains(e.target.value)} />
          <p className="hint">Comma separated. Blank inherits the server setting (currently: {settings.effective.allowedDomains.length ? settings.effective.allowedDomains.join(', ') : 'any address'}).</p>
        </div>
        <div className="field">
          <label htmlFor="verify">Email verification at first sign-in</label>
          <select id="verify" value={verify} onChange={(e) => setVerify(e.target.value as typeof verify)}>
            <option value="inherit">Server default ({settings.effective.verifyEmail ? 'on' : 'off'})</option>
            <option value="on">On - a one-time code is emailed</option>
            <option value="off">Off - anyone may claim an address that has no key</option>
          </select>
        </div>
      </section>

      <section className="card stack">
        <h3>Email sender</h3>
        <div className="field">
          <label htmlFor="fromName">From name</label>
          <input id="fromName" value={fromName} maxLength={200} onChange={(e) => setFromName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="fromEmail">From address</label>
          <input id="fromEmail" type="email" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} />
          <p className="hint">Emails currently go out as: <span className="mono">{settings.effective.mailFrom}</span></p>
        </div>
        <label className="check">
          <input type="checkbox" checked={showDetails} onChange={(e) => setShowDetails(e.target.checked)} />
          <span>Show the request's details in approval emails</span>
        </label>
        <p className="hint">Approvers see what was submitted (up to 12 fields) right in the email, above the Approve, Send back and Reject buttons. Turn this off if your forms hold information that should not be sent by email; the buttons stay.</p>
      </section>

      <div className="actions">
        <button className="primary" disabled={act.busy} onClick={() => void submit()}>{act.busy ? 'Saving…' : 'Save settings'}</button>
      </div>
    </div>
  );
}

export function AdminSettings() {
  const { data, error, reload } = useLoad<{ settings: TenantSettings }>('/admin/settings');
  if (error) return <p className="notice error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <>
      <div className="page-head"><h1>Settings</h1></div>
      <SettingsForm
        settings={data.settings}
        save={async (patch) => {
          await api('/admin/settings', { method: 'PATCH', body: patch });
          reload();
        }}
      />
    </>
  );
}
