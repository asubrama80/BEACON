export interface GuestVerificationCapabilities {
  chat: boolean;
  warRoom: boolean;
}

function toCapabilities(raw: unknown): GuestVerificationCapabilities {
  const value = (raw ?? {}) as Record<string, unknown>;
  return { chat: value.chat === true, warRoom: value.warRoom === true };
}

export interface OtpRequestedResult {
  maskedDestination: string;
  resendAvailableAt: string;
  otpExpiresAt: string;
}

/** The safe, scoped Guest identity carried on `request.authGuest` — no RBAC role, no global
 * permission, no destination. See claude/prompts/18-otp-verification.md, "Guest context". */
export interface AuthenticatedGuest {
  guestInvitationId: string;
  guestSessionId: string;
  incidentId: string;
  guestName: string;
  capabilities: GuestVerificationCapabilities;
  /** Module 19 — the roster row id, needed to author Chat messages / War Room sessions. `null`
   * only in the narrow window between OTP verification and the same transaction's auto-enrollment
   * insert — practically unreachable outside a test, since both happen in one transaction. */
  participantId: string | null;
}

export interface GuestSessionInfo {
  guestName: string;
  incidentId: string;
  capabilities: GuestVerificationCapabilities;
  expiresAt: string;
}

export { toCapabilities };
