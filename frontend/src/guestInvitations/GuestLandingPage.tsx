import { useEffect, useState } from "react";
import { getPublicInvitation } from "./api";
import type { PublicInvitation } from "./types";
import { requestGuestOtp, verifyGuestOtp, getGuestSession, guestLogout, type GuestSessionInfo } from "../guestVerification/api";
import GuestChatPanel from "../guestVerification/GuestChatPanel";
import GuestWarRoomPanel from "../guestVerification/GuestWarRoomPanel";

const REASON_MESSAGE: Record<string, string> = {
  expired: "This invitation link has expired.",
  revoked: "This invitation has been revoked.",
  not_found: "This invitation link is not valid.",
  incident_not_eligible: "This incident is closed and no longer accepts guest access.",
  already_used: "This invitation has already been used.",
};

/** Errors that mean the invitation itself is no longer usable — shown as a full-page terminal
 * state rather than an inline retryable error on the OTP form. */
const TERMINAL_ERROR_CODES = new Set(["invitation_expired", "invitation_revoked", "incident_closed", "invitation_not_found"]);

interface GuestLandingPageProps {
  token: string;
}

type Phase = "loading" | "invalid" | "landing" | "otpSent" | "verified";

/**
 * The public, unauthenticated guest-invitation landing page — reached via
 * `{PUBLIC_BASE_URL}/guest/invite/{token}`, rendered outside the authenticated app shell (no
 * BEACON session exists yet at this point). Owns the full possession-link → OTP-request →
 * OTP-verify → authenticated-Guest flow. See claude/prompts/18-otp-verification.md, "Frontend".
 */
export default function GuestLandingPage({ token }: GuestLandingPageProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>("loading");
  const [invitation, setInvitation] = useState<PublicInvitation | null>(null);
  const [terminalReason, setTerminalReason] = useState<string | null>(null);
  const [maskedDestination, setMaskedDestination] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<GuestSessionInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const existing = await getGuestSession().catch(() => null);
      if (cancelled) return;
      if (existing) {
        setSession(existing);
        setPhase("verified");
        return;
      }
      try {
        const result = await getPublicInvitation(token);
        if (cancelled) return;
        setInvitation(result);
        if (result.valid) {
          setPhase("landing");
        } else {
          setTerminalReason(result.reason ?? "not_found");
          setPhase("invalid");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to load this invitation.");
          setPhase("invalid");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleRequestOtp(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await requestGuestOtp(token);
      setMaskedDestination(result.maskedDestination);
      setPhase("otpSent");
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code && TERMINAL_ERROR_CODES.has(code)) {
        setTerminalReason(code.replace("invitation_", "").replace("incident_closed", "incident_not_eligible"));
        setPhase("invalid");
      } else {
        setError(err instanceof Error ? err.message : "Unable to send a verification code.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await verifyGuestOtp(token, code);
      // The verify response doesn't carry capabilities — the session cookie is now set, so fetch
      // the authoritative context the same way a page refresh would.
      const info = await getGuestSession();
      if (info) {
        setSession(info);
        setPhase("verified");
      } else {
        setError("Verification succeeded, but the session could not be confirmed. Please try again.");
      }
    } catch (err) {
      const errCode = (err as { code?: string }).code;
      if (errCode && TERMINAL_ERROR_CODES.has(errCode)) {
        setTerminalReason(errCode.replace("invitation_", "").replace("incident_closed", "incident_not_eligible"));
        setPhase("invalid");
      } else {
        setError(err instanceof Error ? err.message : "That code did not work.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout(): Promise<void> {
    setBusy(true);
    try {
      await guestLogout();
    } finally {
      setBusy(false);
      window.location.reload();
    }
  }

  return (
    <div className="app-shell-loading" style={{ flexDirection: "column", gap: 16 }}>
      <div className="card" style={{ maxWidth: phase === "verified" ? 520 : 420, padding: 24, textAlign: "center" }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>BEACON Guest {phase === "verified" ? "Portal" : "Invitation"}</h1>

        {phase === "loading" && <p className="cell-muted">Loading…</p>}

        {phase === "invalid" && (
          <p className="error-banner" role="alert">
            {error ?? REASON_MESSAGE[terminalReason ?? "not_found"] ?? "This invitation link is not valid."}
          </p>
        )}

        {phase === "landing" && invitation && (
          <>
            <p className="cell-primary">
              {invitation.incidentNumber} — {invitation.incidentTitle}
            </p>
            <p className="cell-muted">
              You've been invited as a guest{invitation.guestName ? `, ${invitation.guestName}` : ""}.
            </p>
            {invitation.maskedDestination && (
              <p className="cell-muted">A verification code will be sent to {invitation.maskedDestination}.</p>
            )}
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
            <div className="detail-actions" style={{ justifyContent: "center", marginTop: 16 }}>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void handleRequestOtp()}>
                Begin Verification
              </button>
            </div>
          </>
        )}

        {phase === "otpSent" && (
          <>
            <p className="cell-muted">Code sent to {maskedDestination ?? "your destination"}.</p>
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
            <div className="form-row">
              <label htmlFor="guest-otp-code">6-digit code</label>
              <input
                id="guest-otp-code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <div className="detail-actions" style={{ justifyContent: "center", marginTop: 12 }}>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void handleRequestOtp()}>
                Resend code
              </button>
              <button type="button" className="btn btn-primary" disabled={busy || code.length !== 6} onClick={() => void handleVerify()}>
                Verify
              </button>
            </div>
          </>
        )}

        {phase === "verified" && session && (
          <>
            <p className="cell-primary">Welcome, {session.guestName}.</p>
            <p className="cell-muted">You are verified for this incident.</p>

            {session.capabilities.chat && <GuestChatPanel incidentId={session.incidentId} />}
            {session.capabilities.warRoom && <GuestWarRoomPanel incidentId={session.incidentId} />}
            {!session.capabilities.chat && !session.capabilities.warRoom && (
              <p className="cell-muted" style={{ marginTop: 8, fontSize: 12 }}>
                No additional incident access has been granted for this invitation.
              </p>
            )}

            <div className="detail-actions" style={{ justifyContent: "center", marginTop: 16 }}>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void handleLogout()}>
                Log out
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
