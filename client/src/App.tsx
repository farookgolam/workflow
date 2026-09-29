import type { MouseEvent, ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { RequireAuth, useAuth } from './auth';
import { useSite } from './site';
import { api as apiClient } from './api';
import { openManual } from './manuals';
import { ThemeToggle } from './theme';
import { ApprovalPage, ApproveLinkPage } from './pages/Approval';
import { LoginScreen } from './pages/Login';
import { HomePage } from './pages/Home';
import { AccountPage, NewRequestPage, RequestPage, ResubmitPage } from './pages/Requests';
import { AdminDashboard } from './pages/admin/Dashboard';
import { AdminFormEditor, AdminForms } from './pages/admin/Forms';
import { AdminRequestDetail, AdminRequests } from './pages/admin/Requests';
import { AdminLookups } from './pages/admin/Lookups';
import { AdminReports } from './pages/admin/Reports';
import { AdminHoursReport } from './pages/admin/HoursReport';
import { AdminSettings } from './pages/admin/Settings';
import { AdminAudit, AdminUsers } from './pages/admin/UsersAudit';

function Shell() {
  const { user, support, signOut } = useAuth();
  const site = useSite();
  return (
    <>
      {support && (
        <p className="notice" style={{ margin: 0, borderRadius: 0 }}>
          Support session: you are signed in as <strong>{user?.displayName}</strong> from the global management console. Everything you do here is
          recorded in this organisation's audit log.
        </p>
      )}
      <header className="topbar">
        <Link to="/" className="brand">
          {site?.logoDataUrl && <img src={site.logoDataUrl} alt="" style={{ height: 24, verticalAlign: 'middle', marginRight: 8 }} />}
          {site?.name ?? 'Approvals'}
        </Link>
        {user?.roles.includes('Admin') && (
          <nav className="nav" aria-label="Administration">
            <NavLink to="/admin" end>Dashboard</NavLink>
            <NavLink to="/admin/requests">Requests</NavLink>
            <NavLink to="/admin/forms">Forms</NavLink>
            <NavLink to="/admin/lookups">Lookups</NavLink>
            <NavLink to="/admin/reports">Reports</NavLink>
            <NavLink to="/admin/users">Users</NavLink>
            <NavLink to="/admin/audit">Audit log</NavLink>
            <NavLink to="/admin/settings">Settings</NavLink>
          </nav>
        )}
        <span className="spacer" />
        {user && (
          <>
            <HelpLink admin={user.roles.includes('Admin')} />
            <ThemeToggle />
            <Link to="/account" className="who" title="Change password key">{user.displayName}</Link>
            <button className="link" onClick={() => void signOut()}>Sign out</button>
          </>
        )}
      </header>
      <main className="page"><Outlet /></main>
    </>
  );
}

/** Opens a manual in a new tab: the User Manual for everyone, and the Administrator Manual too for administrators. */
function HelpLink({ admin }: { admin: boolean }) {
  const open = (manual: 'user' | 'admin') => (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    (e.currentTarget.closest('details') as HTMLDetailsElement | null)?.removeAttribute('open');
    void openManual(() => apiClient<{ url: string }>('/help/link', { method: 'POST', body: { manual } }));
  };
  const user = <a href="#help" onClick={open('user')}>{admin ? 'User Manual' : 'Help'}</a>;
  if (!admin) return <span className="help-link">{user}</span>;
  return (
    <details className="help-menu">
      <summary>Help</summary>
      <div className="help-pop">
        <a href="#help" onClick={open('admin')}>Administrator Manual</a>
        {user}
      </div>
    </details>
  );
}

/** UI convenience only - every /admin API call is independently authorised on the server. */
function AdminOnly() {
  const { user } = useAuth();
  return user?.roles.includes('Admin') ? <Outlet /> : <Navigate to="/" replace />;
}

function Bare({ children }: { children: ReactNode }) {
  return <main className="page narrow">{children}</main>;
}

/** Links emailed before the move to a single organisation looked like /t/<org>/approve?token=… - keep them working. */
function LegacyTenantLink() {
  const rest = useParams()['*'] ?? '';
  const { search } = useLocation();
  return <Navigate to={`/${rest}${search}`} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route path="/t/:slug/*" element={<LegacyTenantLink />} />
      <Route path="/" element={<RequireAuth><Shell /></RequireAuth>}>
        <Route index element={<HomePage />} />
        <Route path="approve" element={<ApproveLinkPage />} />
        <Route path="approvals/:requestStepId" element={<ApprovalPage />} />
        <Route path="requests/new/:formId" element={<NewRequestPage />} />
        <Route path="requests/:requestId" element={<RequestPage />} />
        <Route path="requests/:requestId/edit" element={<ResubmitPage />} />
        <Route path="account" element={<AccountPage />} />
        <Route path="admin" element={<AdminOnly />}>
          <Route index element={<AdminDashboard />} />
          <Route path="requests" element={<AdminRequests />} />
          <Route path="requests/:requestId" element={<AdminRequestDetail />} />
          <Route path="forms" element={<AdminForms />} />
          <Route path="forms/:formId" element={<AdminFormEditor />} />
          <Route path="lookups" element={<AdminLookups />} />
          <Route path="reports" element={<AdminReports />} />
          <Route path="reports/hours" element={<AdminHoursReport />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="audit" element={<AdminAudit />} />
          <Route path="settings" element={<AdminSettings />} />
        </Route>
      </Route>
      <Route path="*" element={<Bare><div className="card"><h1>Page not found</h1><Link to="/">Go to the home page</Link></div></Bare>} />
    </Routes>
  );
}
