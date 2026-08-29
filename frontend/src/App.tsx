import "./App.css";

export default function App(): JSX.Element {
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
        <div>
          <h1 className="app-shell-title">BEACON</h1>
          <p className="app-shell-subtitle">Emergency Communication Platform</p>
        </div>
      </header>

      <main className="app-shell-main">
        <div className="app-shell-status-card">
          <h2>Application shell is running</h2>
          <p>Business modules are implemented in later steps.</p>
        </div>
      </main>
    </div>
  );
}
