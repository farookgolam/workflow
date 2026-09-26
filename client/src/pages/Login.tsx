import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, forgotKey, startSignIn, type StartResult } from '../api';
import { safeNext, useAuth } from '../auth';
import { AuthLayout } from '../authLayout';
import { useSite } from '../site';

/** 6 boxes' worth of digits in one field: numeric keypad on phones, masked for the password key. */
function DigitsInput(props: { id: string; value: string; onChange(v: string): void; masked?: boolean; autoFocus?: boolean; autoComplete?: string; invalid?: boolean }) {
  return (
    <input
      id={props.id}
      className="digits"
      type={props.masked ? 'password' : 'text'}
      inputMode="numeric"
      pattern="\d{6}"
      maxLength={6}
      required
      autoFocus={props.autoFocus}
      autoComplete={props.autoComplete ?? 'off'}
      aria-invalid={props.invalid}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
    />
  );
}

const friendly = (err: unknown) =>
  err instanceof ApiError && err.status === 429 ? 'Too many attempts. Please wait a minute.' : err instanceof ApiError && err.status < 500 ? err.message : 'Something went wrong. Please try again.';

/** The sign-in page in its frame: the organisation's name and logo on the black panel. */
export function LoginScreen() {
  const site = useSite();
  return (
    <AuthLayout
      name={site?.name ?? 'Approvals'}
      logo={site?.logoDataUrl}
      title={<>Requests and <em>approvals</em></>}
      lead="Submit a form, follow it through each approval step, and keep the signed PDF of every decision."
      foot="Your 6-digit password key is yours alone. Nobody from support will ever ask for it."
    >
      <LoginPage />
    </AuthLayout>
  );
}

export function LoginPage() {
  const { user, ready, signIn, setUp, resetKey } = useAuth();
  const site = useSite(); // the customer this address belongs to, for the name and logo
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const next = safeNext(params.get('next'));

  const [step, setStep] = useState<'email' | 'password' | 'setup' | 'reset'>('email');
  const [start, setStart] = useState<Extract<StartResult, { next: 'setup' }> | null>(null);
  const [email, setEmail] = useState('');
  const [key, setKey] = useState('');
  const [confirm, setConfirm] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  if (ready && user) return <Navigate to={next} replace />;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setFieldErrors({});
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'validation_failed' && err.details.length) setFieldErrors(err.fieldErrors);
      else setError(friendly(err));
    } finally {
      setBusy(false);
    }
  };
  const back = () => { setStep('email'); setKey(''); setConfirm(''); setCode(''); setError(''); setFieldErrors({}); };

  const submitEmail = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await startSignIn(email);
      if (r.next === 'setup') { setStart(r); setName(r.displayName ?? ''); }
      setStep(r.next);
    });
  };
  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      try {
        await signIn(email, key);
        navigate(next, { replace: true });
      } catch (err) {
        setKey('');
        throw err;
      }
    });
  };
  const submitSetup = (e: FormEvent) => {
    e.preventDefault();
    if (key !== confirm) return setFieldErrors({ confirm: 'The two keys do not match' });
    void run(async () => {
      await setUp({ email, passwordKey: key, code: start?.verification ? code : undefined, displayName: start?.needsName ? name.trim() : undefined });
      navigate(next, { replace: true });
    });
  };

  const beginReset = () =>
    void run(async () => {
      await forgotKey(email);
      setKey(''); setConfirm(''); setCode('');
      setStep('reset');
    });
  const submitReset = (e: FormEvent) => {
    e.preventDefault();
    if (key !== confirm) return setFieldErrors({ confirm: 'The two keys do not match' });
    void run(async () => {
      await resetKey({ email, code, passwordKey: key });
      navigate(next, { replace: true });
    });
  };

  const notices = (
    <>
      {params.get('next')?.startsWith('/approve') && step === 'email' && <p className="notice">Sign in to open your approval link.</p>}
      {error && <p className="notice bad" role="alert">{error}</p>}
    </>
  );

  if (step === 'email') {
    return (
      <form className="card" onSubmit={submitEmail}>
        <h1>Sign in</h1>
        {notices}
        <div className="field">
          <label htmlFor="email">Work email</label>
          <input id="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Continue'}</button>
        <p className="muted small">First time here? Enter your email and you will be asked to create your 6-digit password key.</p>
      </form>
    );
  }

  if (step === 'password') {
    return (
      <form className="card" onSubmit={submitPassword}>
        <h1>Enter your password key</h1>
        <p className="muted">{email} · <button type="button" className="link" onClick={back}>change</button></p>
        {notices}
        {/* lets password managers pair the key with the right account */}
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <div className="field">
          <label htmlFor="key">6-digit password key</label>
          <DigitsInput id="key" value={key} onChange={setKey} masked autoFocus autoComplete="current-password" />
        </div>
        <button className="primary" type="submit" disabled={busy || key.length !== 6}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="muted small"><button type="button" className="link" disabled={busy} onClick={beginReset}>Forgot your key?</button> We will email you a code so you can choose a new one.</p>
      </form>
    );
  }

  if (step === 'reset') {
    return (
      <form className="card" onSubmit={submitReset}>
        <h1>Choose a new password key</h1>
        <p className="muted">{email} · <button type="button" className="link" onClick={back}>change</button></p>
        {notices}
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <div className="field">
          <label htmlFor="rcode">Verification code</label>
          <DigitsInput id="rcode" value={code} onChange={setCode} autoFocus autoComplete="one-time-code" invalid={!!fieldErrors.code} />
          {fieldErrors.code ? <p className="field-error">{fieldErrors.code}</p> : <p className="hint">If {email} has an account, we have emailed it a 6-digit code. It expires in 10 minutes.</p>}
        </div>
        <div className="field">
          <label htmlFor="rkey">New 6-digit password key</label>
          <DigitsInput id="rkey" value={key} onChange={setKey} masked autoComplete="new-password" invalid={!!fieldErrors.passwordKey} />
          {fieldErrors.passwordKey ? <p className="field-error">{fieldErrors.passwordKey}</p> : <p className="hint">Digits only. Obvious keys such as 123456 or 111111 are refused.</p>}
        </div>
        <div className="field">
          <label htmlFor="rconfirm">Repeat the key</label>
          <DigitsInput id="rconfirm" value={confirm} onChange={setConfirm} masked autoComplete="new-password" invalid={!!fieldErrors.confirm} />
          {fieldErrors.confirm && <p className="field-error">{fieldErrors.confirm}</p>}
        </div>
        <button className="primary" type="submit" disabled={busy || code.length !== 6 || key.length !== 6 || confirm.length !== 6}>{busy ? 'Saving…' : 'Save new key and sign in'}</button>
        <p className="muted small">No email? Check junk mail, or go back and try again after a minute. If you can no longer read that mailbox, ask an administrator to reset your key.</p>
      </form>
    );
  }

  return (
    <form className="card" onSubmit={submitSetup}>
      <h1>Create your password key</h1>
      <p className="muted">{email} · <button type="button" className="link" onClick={back}>change</button></p>
      {notices}
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      {start?.verification && (
        <div className="field">
          <label htmlFor="code">Verification code</label>
          <DigitsInput id="code" value={code} onChange={setCode} autoFocus autoComplete="one-time-code" invalid={!!fieldErrors.code} />
          {fieldErrors.code ? <p className="field-error">{fieldErrors.code}</p> : <p className="hint">We emailed a 6-digit code to {email}. It expires in 10 minutes.</p>}
        </div>
      )}
      {start?.needsName && (
        <div className="field">
          <label htmlFor="name">Your full name</label>
          <input id="name" autoComplete="name" required minLength={2} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!fieldErrors.displayName} />
          {fieldErrors.displayName && <p className="field-error">{fieldErrors.displayName}</p>}
        </div>
      )}
      <div className="field">
        <label htmlFor="newkey">Choose a 6-digit password key</label>
        <DigitsInput id="newkey" value={key} onChange={setKey} masked autoComplete="new-password" invalid={!!fieldErrors.passwordKey} autoFocus={!start?.verification} />
        {fieldErrors.passwordKey ? <p className="field-error">{fieldErrors.passwordKey}</p> : <p className="hint">Digits only. Avoid obvious keys such as 123456 or 111111 - they are refused.</p>}
      </div>
      <div className="field">
        <label htmlFor="confirm">Repeat the key</label>
        <DigitsInput id="confirm" value={confirm} onChange={setConfirm} masked autoComplete="new-password" invalid={!!fieldErrors.confirm} />
        {fieldErrors.confirm && <p className="field-error">{fieldErrors.confirm}</p>}
      </div>
      <button className="primary" type="submit" disabled={busy || key.length !== 6 || confirm.length !== 6 || (!!start?.verification && code.length !== 6)}>{busy ? 'Saving…' : 'Create key and sign in'}</button>
      {start?.verification && <p className="muted small">No email? Check junk mail, or go back and continue again after a minute to get a new code.</p>}
    </form>
  );
}
