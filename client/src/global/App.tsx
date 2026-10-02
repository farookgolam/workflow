import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { openManual } from '../manuals';
import { ThemeToggle } from '../theme';
import { gapi } from './api';
import { useGlobalAuth } from './auth';
import { About } from './pages/About';
import { Customers } from './pages/Customers';
import { CustomerDetail } from './pages/CustomerDetail';
import { GlobalAdmins } from './pages/GlobalAdmins';
import { GlobalLogin } from './pages/Login';

export function GlobalApp() {
  const { admin, ready, signOut } = useGlobalAuth();
  if (!ready) return <p className="muted center">Loading…</p>;
  if (!admin) return <GlobalLogin />;

  return (
    <>
      <header className="topbar">
        {/* FileBank's own site: the FileBank badge (it has a white outline for dark bars), then the product */}
        <Link to="/" className="brand"><img className="own" src="/filebank-logo.png" alt="FileBank" />WorkFlow Global</Link>
        <nav className="nav" aria-label="Global management">
          <NavLink to="/" end>Customers</NavLink>
          <NavLink to="/administrators">Administrators</NavLink>
          <NavLink to="/about">About</NavLink>
        </nav>
        <span className="spacer" />
        <span className="help-link"><a href="#help" onClick={(e) => { e.preventDefault(); void openManual(() => gapi<{ url: string }>('/help/link', { method: 'POST' })); }}>Help</a></span>
        <ThemeToggle />
        <span className="who">{admin.displayName}</span>
        <button className="link" onClick={() => void signOut()}>Sign out</button>
      </header>
      <main className="page">
        <Routes>
          <Route path="/" element={<Customers />} />
          <Route path="/customers/:tenantId" element={<CustomerDetail />} />
          <Route path="/administrators" element={<GlobalAdmins />} />
          <Route path="/about" element={<About />} />
          <Route path="*" element={<div className="card"><h1>Page not found</h1><Link to="/">Go to the customer list</Link></div>} />
        </Routes>
      </main>
    </>
  );
}
