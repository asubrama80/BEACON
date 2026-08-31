import type { FastifyRequest } from "fastify";
import { getDb } from "@beacon/database";
import { findInvitationAuthContext } from "../guestInvitations/guestInvitationQueries.js";
import { NOT_AUTHENTICATED } from "../auth/errors.js";
import type { GuestVerificationConfig } from "./config.js";
import { hashGuestSessionToken } from "./guestSessionToken.js";
import { findActiveGuestSessionByTokenHash, touchGuestSession } from "./guestVerificationQueries.js";
import { toCapabilities } from "./guestVerificationDto.js";

/**
 * Reusable Guest-authentication preHandler — deliberately separate from `authenticateUser()`
 * (`auth/plugin.ts`): a Guest session cookie is never accepted by a registered-User route, and
 * `authenticateUser()` is never weakened or touched by this module. Re-validates Incident/
 * invitation state on every call (not just cookie expiry) — a Guest's access must stop the
 * instant the Incident closes or the invitation/session is revoked, even mid-cookie-lifetime. See
 * claude/prompts/18-otp-verification.md, "Guest authentication".
 */
export function createAuthenticateGuestHook(config: GuestVerificationConfig) {
  return async function authenticateGuest(request: FastifyRequest): Promise<void> {
    const token = request.cookies[config.guestSessionCookieName];
    if (!token) {
      throw NOT_AUTHENTICATED;
    }

    const db = getDb();
    const tokenHash = hashGuestSessionToken(token);
    const now = new Date();
    const session = await findActiveGuestSessionByTokenHash(db, tokenHash, now);
    if (!session) {
      throw NOT_AUTHENTICATED;
    }

    const invitation = await findInvitationAuthContext(db, session.invitationId);
    if (!invitation || invitation.revokedAt || invitation.status === "revoked" || invitation.incidentStatus === "closed") {
      throw NOT_AUTHENTICATED;
    }

    await touchGuestSession(db, session.id, now);

    request.authGuest = {
      guestInvitationId: invitation.id,
      guestSessionId: session.id,
      incidentId: invitation.incidentId,
      guestName: invitation.guestName,
      capabilities: toCapabilities(invitation.permissions),
    };
  };
}
