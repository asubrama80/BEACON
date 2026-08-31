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
}

export interface GuestSessionInfo {
  guestName: string;
  incidentId: string;
  capabilities: GuestVerificationCapabilities;
  expiresAt: string;
}

export { toCapabilities };
