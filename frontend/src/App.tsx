import "./App.css";
import { AuthProvider } from "./auth/AuthContext";
import { useAuth } from "./auth/useAuth";
import LoginPage from "./auth/LoginPage";

export default function App(): JSX.Element {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

function AppShell(): JSX.Element {
  const { user, loading, logout } = useAuth();

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
        <div className="app-shell-user">
          <span className="app-shell-user-name">{user.displayName}</span>
          <button type="button" className="app-shell-logout" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>

      <main className="app-shell-main">
        <div className="app-shell-status-card">
          <h2>Signed in</h2>
          <p>Business modules are implemented in later steps.</p>
        </div>
      </main>
    </div>
  );
}
