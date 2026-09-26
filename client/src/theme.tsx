// Light / dark / system. "System" follows the computer's setting (styles.css, prefers-color-scheme); Light or Dark
// is set on <html data-theme> and remembered in this browser only. Applied before the app renders (main.tsx).
import { useState, type ReactElement } from 'react';

export type Theme = 'system' | 'light' | 'dark';
const KEY = 'theme';
const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<Theme, string> = { system: 'System', light: 'Light', dark: 'Dark' };

export function storedTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch { return 'system'; } // storage blocked: follow the computer
}

export function applyTheme(t: Theme): void {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

function saveTheme(t: Theme): void {
  try { if (t === 'system') localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* not remembered */ }
  applyTheme(t);
}

const ICONS: Record<Theme, ReactElement> = {
  light: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></>,
  dark: <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z" />,
  system: <><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16v4" /></>,
};

/** One button that steps through System, Light and Dark; the icon shows the current choice. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const next = NEXT[theme];
  return (
    <button type="button" className="theme-toggle" title={`Theme: ${LABEL[theme]} - click for ${LABEL[next]}`} aria-label={`Theme: ${LABEL[theme]}. Switch to ${LABEL[next]}`}
      onClick={() => { saveTheme(next); setTheme(next); }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICONS[theme]}</svg>
    </button>
  );
}
