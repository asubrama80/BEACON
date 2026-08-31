import { useEffect, useState } from "react";
import { getPublicInvitation } from "./api";
import type { PublicInvitation } from "./types";

const REASON_MESSAGE: Record<string, string> = {
  expired: "This invitation link has expired.",
  revoked: "This invitation has been revoked.",
  not_found: "This invitation link is not valid.",
  incident_not_eligible: "This incident is closed and no longer accepts guest access.",
  already_used: "This invitation has already been used.",
};

interface GuestLandingPageProps {
  token: string;
}

/**
 * The public, unauthenticated guest-invitation landing page — reached via
 * `{PUBLIC_BASE_URL}/guest/invite/{token}`, rendered outside the authenticated app shell (no
 * BEACON session exists yet at this point). Only validates and displays the invitation; the
 * actual OTP verification flow is Module 18's responsibility. See
 * claude/prompts/17-guest-invitations.md, "Public landing page".
 */
export default function GuestLandingPage({ token }: GuestLandingPageProps): JSX.Element {
  const [invitation, setInvitation] = useState<PublicInvitation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPublicInvitation(token)
      .then((result) => {
        if (!cancelled) setInvitation(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load this invitation.");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="app-shell-loading" style={{ flexDirection: "column", gap: 16 }}>
      <div className="card" style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>BEACON Guest Invitation</h1>

        {error && <p className="error-banner">{error}</p>}

        {!error && !invitation && <p className="cell-muted">Loading invitation…</p>}

        {invitation && !invitation.valid && (
          <p className="error-banner" role="alert">
            {REASON_MESSAGE[invitation.reason ?? "not_found"] ?? "This invitation link is not valid."}
          </p>
        )}

        {invitation && invitation.valid && (
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
            <div className="detail-actions" style={{ justifyContent: "center", marginTop: 16 }}>
              <button type="button" className="btn btn-primary" disabled>
                Begin Verification
              </button>
            </div>
            <p className="cell-muted" style={{ marginTop: 8, fontSize: 12 }}>
              Verification is not available yet in this build.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
