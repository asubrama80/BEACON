import { useState } from "react";
import "./App.css";
import { AuthProvider } from "./auth/AuthContext";
import { useAuth } from "./auth/useAuth";
import LoginPage from "./auth/LoginPage";
import UsersPage from "./users/UsersPage";
import ContactsPage from "./contacts/ContactsPage";
import GroupsPage from "./groups/GroupsPage";
import TemplatesPage from "./templates/TemplatesPage";
import IncidentsPage from "./incidents/IncidentsPage";
import AlertsPage from "./alerts/AlertsPage";
import GuestLandingPage from "./guestInvitations/GuestLandingPage";
import AuditPage from "./audit/AuditPage";
import DashboardPage from "./dashboard/DashboardPage";
import AdministrationPage from "./admin/AdministrationPage";

const GUEST_INVITE_PATH = /^\/guest\/invite\/(.+)$/;

export default function App(): JSX.Element {
  // A public guest-invitation link has no BEACON session — render it entirely outside
  // AuthProvider/AppShell, before any authenticated-app machinery runs. See
  // claude/prompts/17-guest-invitations.md, "Public landing page routing".
  const guestInviteMatch = window.location.pathname.match(GUEST_INVITE_PATH);
  if (guestInviteMatch) {
    return <GuestLandingPage token={decodeURIComponent(guestInviteMatch[1]!)} />;
  }

  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

type View = "dashboard" | "users" | "contacts" | "groups" | "templates" | "incidents" | "alerts" | "audit" | "administration";

const BRAND_MARK_PATH = (
  <>
    <path d="M11 5 6 9H3v6h3l5 4V5Z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    <path d="M18.5 5.5a9 9 0 0 1 0 13" />
  </>
);

/** One entry per sidebar item — icon paths lifted directly from the stakeholder prototype's own
 * sidebar markup where a matching nav concept exists there; a couple (Users) have no prototype
 * equivalent and use a reasonable icon in the same visual language instead. */
const NAV_ICONS: Record<View, JSX.Element> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  incidents: (
    <>
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 4.2 2.6 18a1.8 1.8 0 0 0 1.6 2.7h15.6a1.8 1.8 0 0 0 1.6-2.7L13.7 4.2a1.8 1.8 0 0 0-3.4 0Z" />
    </>
  ),
  alerts: (
    <>
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
    </>
  ),
  contacts: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.6 3.1-6.5 7-6.5s7 2.9 7 6.5" />
    </>
  ),
  groups: (
    <>
      <circle cx="8.5" cy="8" r="3" />
      <circle cx="16" cy="9" r="2.5" />
      <path d="M2.8 19c0-3.2 2.6-5.6 5.7-5.6s5.7 2.4 5.7 5.6" />
      <path d="M14.5 13.8c2.6.2 4.7 2.4 4.7 5.2" />
    </>
  ),
  templates: (
    <>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
      <path d="M9 12.5h6M9 16h6" />
    </>
  ),
  users: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </>
  ),
  audit: (
    <>
      <path d="M12 3.5 5 6v6c0 4.3 2.9 7.4 7 8.5 4.1-1.1 7-4.2 7-8.5V6z" />
      <path d="m9.2 12 1.9 1.9 3.7-3.9" />
    </>
  ),
  administration: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13.5a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1h-.2a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.6v-.2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.6 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1Z" />
    </>
  ),
};

const NAV_LABELS: Record<View, string> = {
  dashboard: "Dashboard",
  incidents: "Incidents",
  alerts: "Alerts",
  contacts: "Contacts",
  groups: "Groups",
  templates: "Templates",
  users: "Users",
  audit: "Audit",
  administration: "Administration",
};

function AppShell(): JSX.Element {
  const { user, loading, logout } = useAuth();
  const [view, setView] = useState<View>("dashboard");
  const [alertsDeepLink, setAlertsDeepLink] = useState<{ alertId?: string; createIncidentId?: string } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  function navigateToAlerts(request: { alertId?: string; createIncidentId?: string }): void {
    setAlertsDeepLink(request);
    setView("alerts");
  }

  function goTo(next: View): void {
    setView(next);
    setSidebarOpen(false);
  }

  if (loading) {
    return (
      <div className="app-shell-loading" role="status">
        Loading…
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  const canViewUsers = user.permissions.includes("users.read");
  const canViewContacts = user.permissions.includes("contacts.read");
  const canViewGroups = user.permissions.includes("groups.read");
  const canViewTemplates = user.permissions.includes("templates.read");
  const canViewIncidents = user.permissions.includes("incidents.read");
  const canViewAlerts = user.permissions.includes("alerts.read");
  const canViewAudit = user.permissions.includes("audit.read");
  const canViewAdmin = user.permissions.includes("admin.read");

  const navEntries: { view: View; visible: boolean }[] = [
    { view: "dashboard", visible: true },
    { view: "incidents", visible: canViewIncidents },
    { view: "alerts", visible: canViewAlerts },
    { view: "contacts", visible: canViewContacts },
    { view: "groups", visible: canViewGroups },
    { view: "templates", visible: canViewTemplates },
    { view: "users", visible: canViewUsers },
    { view: "audit", visible: canViewAudit },
    { view: "administration", visible: canViewAdmin },
  ];

  const initials = user.displayName
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div className="app-shell">
      <div className={`sidebar-scrim ${sidebarOpen ? "is-open" : ""}`} onClick={() => setSidebarOpen(false)} aria-hidden="true" />

      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {BRAND_MARK_PATH}
            </svg>
          </div>
          <div>
            <div className="brand-name">BEACON</div>
            <div className="brand-sub">Emergency Communication Platform</div>
          </div>
        </div>

        <nav className="nav-list" aria-label="Primary">
          {navEntries
            .filter((entry) => entry.visible)
            .map((entry) => (
              <button
                key={entry.view}
                type="button"
                className={`nav-item ${view === entry.view ? "active" : ""}`}
                onClick={() => goTo(entry.view)}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {NAV_ICONS[entry.view]}
                </svg>
                <span className="nav-label">{NAV_LABELS[entry.view]}</span>
              </button>
            ))}
        </nav>

        <div className="sidebar-user">
          <div className="user-avatar" aria-hidden="true">
            {initials || "?"}
          </div>
          <div>
            <div className="user-name">{user.displayName}</div>
            <button type="button" className="user-logout-link" onClick={() => void logout()}>
              Log out
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-left">
            <button
              type="button"
              className="hamburger"
              aria-label={sidebarOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen((open) => !open)}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <h1 className="page-title">{NAV_LABELS[view]}</h1>
          </div>
          <div className="topbar-right">
            <div className="topbar-avatar" aria-hidden="true">
              {initials || "?"}
            </div>
          </div>
        </header>

        <main className="content">
          {view === "users" && canViewUsers ? (
            <UsersPage />
          ) : view === "incidents" && canViewIncidents ? (
            <IncidentsPage onNavigateToAlerts={canViewAlerts ? navigateToAlerts : undefined} />
          ) : view === "alerts" && canViewAlerts ? (
            <AlertsPage deepLink={alertsDeepLink} onDeepLinkHandled={() => setAlertsDeepLink(null)} />
          ) : view === "contacts" && canViewContacts ? (
            <ContactsPage />
          ) : view === "groups" && canViewGroups ? (
            <GroupsPage />
          ) : view === "templates" && canViewTemplates ? (
            <TemplatesPage />
          ) : view === "audit" && canViewAudit ? (
            <AuditPage />
          ) : view === "administration" && canViewAdmin ? (
            <AdministrationPage
              onNavigateToUsers={canViewUsers ? () => setView("users") : undefined}
              onNavigateToAudit={canViewAudit ? () => setView("audit") : undefined}
            />
          ) : (
            <DashboardPage
              onNavigateToIncidents={canViewIncidents ? () => setView("incidents") : undefined}
              onNavigateToAlerts={canViewAlerts ? navigateToAlerts : undefined}
            />
          )}
        </main>
      </div>
    </div>
  );
}
