import { useState, type FormEvent } from "react";
import { apiFetch } from "../lib/api";
import { useAuth } from "./useAuth";
import "./LoginPage.css";

interface LoginErrorBody {
  error?: string;
  message?: string;
}

export default function LoginPage(): JSX.Element {
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [mfaRequired, setMfaRequired] = useState(false);
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const payload: Record<string, string> = { email, password };
      if (mfaRequired) {
        if (useRecoveryCode) {
          payload.recoveryCode = recoveryCode;
        } else {
          payload.totp = totp;
        }
      }

      const response = await apiFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as LoginErrorBody;

      if (response.ok) {
        await refresh();
        return;
      }

      if (body.error === "mfa_required") {
        setMfaRequired(true);
        return;
      }

      setError(body.message ?? "Unable to sign in.");
    } catch {
      setError("Unable to reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={(event) => void handleSubmit(event)}>
        <div className="login-brand">
          <div className="login-brand-mark" aria-hidden="true">
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
            <h1>BEACON</h1>
            <p>Emergency Communication Platform</p>
          </div>
        </div>

        {!mfaRequired ? (
          <>
            <label className="login-field">
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoFocus
                autoComplete="username"
              />
            </label>
            <label className="login-field">
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="current-password"
              />
            </label>
          </>
        ) : (
          <>
            <p className="login-mfa-hint">
              {useRecoveryCode
                ? "Enter one of your one-time recovery codes."
                : "Enter the 6-digit code from your authenticator app."}
            </p>
            {!useRecoveryCode ? (
              <label className="login-field">
                Verification code
                <input
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  value={totp}
                  onChange={(event) => setTotp(event.target.value)}
                  required
                  autoFocus
                />
              </label>
            ) : (
              <label className="login-field">
                Recovery code
                <input
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  required
                  autoFocus
                />
              </label>
            )}
            <button
              type="button"
              className="login-link-button"
              onClick={() => setUseRecoveryCode((current) => !current)}
            >
              {useRecoveryCode ? "Use an authenticator code instead" : "Use a recovery code instead"}
            </button>
          </>
        )}

        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="login-submit" disabled={submitting}>
          {submitting ? "Signing in…" : mfaRequired ? "Verify" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
