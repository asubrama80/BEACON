export interface GuestInvitationConfig {
  /** How long a guest invitation link stays usable before it must be re-issued. */
  ttlHours: number;
  /**
   * Base URL of the frontend web app the guest link opens in a browser — deliberately distinct
   * from `NotificationConfig.publicBaseUrl` (Module 11), which is the *backend* API's own
   * externally-visible URL used only to construct webhook callback URLs. The two are different
   * origins in this project (Vite dev server vs. Fastify API), so reusing the backend's base URL
   * here would build a link that 404s. `null` when unset — dev/test may then fall back to a safe
   * relative path (`/guest/invite/{token}`) per the invitation-URL spec. See
   * claude/prompts/17-guest-invitations.md, "Invitation URL".
   */
  portalBaseUrl: string | null;
}

export function loadGuestInvitationConfig(source: NodeJS.ProcessEnv = process.env): GuestInvitationConfig {
  return {
    ttlHours: Number(source.GUEST_INVITATION_TTL_HOURS ?? 24),
    portalBaseUrl: source.GUEST_PORTAL_BASE_URL ?? null,
  };
}
