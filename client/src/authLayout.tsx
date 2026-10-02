import type { ReactNode } from 'react';
import { ThemeToggle } from './theme';

/**
 * Sign-in pages: a dark brand panel (the organisation's name and logo) beside the form. One column on phones.
 * `filebank`: FileBank's own site (the global console) - the FileBank logo, made for dark backgrounds, above the name.
 */
export function AuthLayout({ name, logo, filebank, title, lead, foot, children }: { name: string; logo?: string | null; filebank?: boolean; title: ReactNode; lead: ReactNode; foot?: ReactNode; children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-brand">
        <div className="auth-top">
          <span className={`auth-mark${filebank ? ' own' : ''}`}>
            {filebank ? <img className="own" src="/filebank-logo-white.png" alt="FileBank Information Management" /> : logo && <img src={logo} alt="" />}
            {name}
          </span>
          <ThemeToggle />
        </div>
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
