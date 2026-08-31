export interface GuestVerificationConfig {
  /** Server-enforced OTP lifetime — never trust a client-side timer. */
  otpTtlMinutes: number;
  /** After this many wrong attempts against one challenge, it is locked (never brute-forceable). */
  otpMaxAttempts: number;
  /** Minimum time between OTP resend requests for the same invitation. */
  otpResendCooldownSeconds: number;
  /** Absolute cap on a Guest session's lifetime, independent of activity. */
  sessionTtlHours: number;
  guestSessionCookieName: string;
  guestCsrfCookieName: string;
  /** Per-IP request-route rate limit — the per-invitation cooldown is the primary defense; this
   * is the secondary per-IP layer. Configurable (mirrors `LOGIN_RATE_LIMIT_MAX`) so tests can
   * raise it well above what a fast sequential test run would otherwise trip. */
  otpRequestRateLimitMax: number;
  otpVerifyRateLimitMax: number;
}

export function loadGuestVerificationConfig(source: NodeJS.ProcessEnv = process.env): GuestVerificationConfig {
  return {
    otpTtlMinutes: Number(source.GUEST_OTP_TTL_MINUTES ?? 10),
    otpMaxAttempts: Number(source.GUEST_OTP_MAX_ATTEMPTS ?? 5),
    otpResendCooldownSeconds: Number(source.GUEST_OTP_RESEND_COOLDOWN_SECONDS ?? 60),
    sessionTtlHours: Number(source.GUEST_SESSION_TTL_HOURS ?? 12),
    guestSessionCookieName: "beacon_guest_session",
    guestCsrfCookieName: "beacon_guest_csrf",
    otpRequestRateLimitMax: Number(source.GUEST_OTP_REQUEST_RATE_LIMIT_MAX ?? 5),
    otpVerifyRateLimitMax: Number(source.GUEST_OTP_VERIFY_RATE_LIMIT_MAX ?? 10),
  };
}
