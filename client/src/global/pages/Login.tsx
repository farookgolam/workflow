import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api';
import { useGlobalAuth } from '../auth';
import { AuthLayout } from '../../authLayout';

export function GlobalLogin() {
  const { signIn } = useGlobalAuth();
  const [email, setEmail] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    void signIn(email, key)
      .catch((err) =>
        setError(err instanceof ApiError && err.status === 429 ? 'Too many attempts. Please wait a minute.' : err instanceof ApiError && err.status < 500 ? err.message : 'Something went wrong. Please try again.'),
      )
      .finally(() => setBusy(false));
  };

  return (
    <AuthLayout
      name="WorkFlow Global"
      filebank
      title={<>Global <em>management</em></>}
      lead="Create and look after customer organisations: their addresses, first administrators, access and support."
      foot="Customers sign in on their own address, not here."
    >
      <div className="card stack">
        <h1>Sign in</h1>
        {error && <p className="notice error">{error}</p>}
        <form className="stack" onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Email address</label>
            <input id="email" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="key">6-digit password key</label>
            <input
              id="key"
              className="digits"
              type="password"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              required
              autoComplete="current-password"
              value={key}
              onChange={(e) => setKey(e.target.value.replace(/\D/g, '').slice(0, 6))}
            />
          </div>
          <div className="actions">
            <button className="primary" disabled={busy || key.length !== 6}>{busy ? 'Signing in…' : 'Sign in'}</button>
          </div>
        </form>
      </div>
    </AuthLayout>
  );
}
