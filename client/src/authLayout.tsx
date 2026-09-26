import type { ReactNode } from 'react';
import { ThemeToggle } from './theme';

/** Sign-in pages: a black brand panel (the organisation's name and logo) beside the form. One column on phones. */
export function AuthLayout({ name, logo, title, lead, foot, children }: { name: string; logo?: string | null; title: ReactNode; lead: ReactNode; foot?: ReactNode; children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-brand">
        <div className="auth-top"><span className="auth-mark">{logo && <img src={logo} alt="" />}{name}</span><ThemeToggle /></div>
        <div>
          <p className="auth-title">{title}</p>
          <p className="auth-lead">{lead}</p>
        </div>
        {foot ? <p className="auth-foot">{foot}</p> : <span />}
      </aside>
      <main className="auth-main"><div>{children}</div></main>
    </div>
  );
}
