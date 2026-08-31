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

type View = "dashboard" | "users" | "contacts" | "groups" | "templates" | "incidents" | "alerts";

function AppShell(): JSX.Element {
  const { user, loading, logout } = useAuth();
  const [view, setView] = useState<View>("dashboard");
  const [alertsDeepLink, setAlertsDeepLink] = useState<{ alertId?: string; createIncidentId?: string } | null>(null);

  function navigateToAlerts(request: { alertId?: string; createIncidentId?: string }): void {
    setAlertsDeepLink(request);
    setView("alerts");
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

  return (
    <div className="app-shell">
      <header className="app-shell-header">
        <div className="app-shell-brand-mark" aria-hidden="true">
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M11 5 6 9H3v6h3l5 4V5Z" />
            <path d="M15.5 8.5a5 5 0 0 1 0 7" />
            <path d="M18.5 5.5a9 9 0 0 1 0 13" />
          </svg>
        </div>
        <div className="app-shell-title-group">
          <h1 className="app-shell-title">BEACON</h1>
          <p className="app-shell-subtitle">Emergency Communication Platform</p>
        </div>

        {(canViewUsers || canViewContacts || canViewGroups || canViewTemplates || canViewIncidents || canViewAlerts) && (
          <nav className="app-shell-nav">
            <button
              type="button"
              className={`app-shell-nav-link ${view === "dashboard" ? "is-active" : ""}`}
              onClick={() => setView("dashboard")}
            >
              Dashboard
            </button>
            {canViewIncidents && (
              <button
                type="button"
                className={`app-shell-nav-link ${view === "incidents" ? "is-active" : ""}`}
                onClick={() => setView("incidents")}
              >
                Incidents
              </button>
            )}
            {canViewAlerts && (
              <button
                type="button"
                className={`app-shell-nav-link ${view === "alerts" ? "is-active" : ""}`}
                onClick={() => setView("alerts")}
              >
                Alerts
              </button>
            )}
            {canViewContacts && (
              <button
                type="button"
                className={`app-shell-nav-link ${view === "contacts" ? "is-active" : ""}`}
                onClick={() => setView("contacts")}
              >
                Contacts
              </button>
            )}
            {canViewGroups && (
              <button
                type="button"
                className={`app-shell-nav-link ${view === "groups" ? "is-active" : ""}`}
                onClick={() => setView("groups")}
              >
                Groups
              </button>
            )}
            {canViewTemplates && (
              <button
                type="button"
                className={`app-shell-nav-link ${view === "templates" ? "is-active" : ""}`}
                onClick={() => setView("templates")}
              >
                Templates
              </button>
            )}
            {canViewUsers && (
              <button
                type="button"
                className={`app-shell-nav-link ${view === "users" ? "is-active" : ""}`}
                onClick={() => setView("users")}
              >
                Users
              </button>
            )}
          </nav>
        )}

        <div className="app-shell-user">
          <span className="app-shell-user-name">{user.displayName}</span>
          <button type="button" className="app-shell-logout" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>

      <main className="app-shell-main">
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
        ) : (
          <div className="app-shell-status-card">
            <h2>Signed in</h2>
            <p>Business modules are implemented in later steps.</p>
          </div>
        )}
      </main>
    </div>
  );
}
