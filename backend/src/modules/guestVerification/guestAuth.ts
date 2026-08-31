import type { FastifyRequest } from "fastify";
import { getDb } from "@beacon/database";
import { findInvitationAuthContext } from "../guestInvitations/guestInvitationQueries.js";
import { findActiveParticipantByGuestInvitation } from "../incidents/participantQueries.js";
import { NOT_AUTHENTICATED, NOT_AUTHORIZED } from "../auth/errors.js";
import type { GuestVerificationConfig } from "./config.js";
import { hashGuestSessionToken } from "./guestSessionToken.js";
import { findActiveGuestSessionByTokenHash, touchGuestSession } from "./guestVerificationQueries.js";
import { toCapabilities, type GuestVerificationCapabilities } from "./guestVerificationDto.js";

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

    // Module 19 — the roster entry, if the guest has one (auto-enrolled at first-time
    // verification). `undefined` here does not necessarily mean "never enrolled" — a manager's
    // removal is also reflected by an absent *active* row, but removal already revokes the
    // session eagerly (see `revokeAllGuestSessionsForInvitation`), so reaching this line with no
    // active participant row is the removal case, not the pre-enrollment race.
    const participant = await findActiveParticipantByGuestInvitation(db, invitation.incidentId, invitation.id);

    request.authGuest = {
      guestInvitationId: invitation.id,
      guestSessionId: session.id,
      incidentId: invitation.incidentId,
      guestName: invitation.guestName,
      capabilities: toCapabilities(invitation.permissions),
      participantId: participant?.id ?? null,
    };
  };
}

/**
 * Module 19 — gates a Guest-facing mutation/subscription on a specific granted capability (Chat,
 * War Room), on top of `authenticateGuest()`'s baseline session/invitation/Incident validity.
 * Mirrors `rbac/guard.ts`'s `requirePermission()` shape for a registered User, but reads from the
 * invitation's own capability toggles rather than RBAC — a Guest never holds a permission code.
 */
export function requireGuestCapability(capability: keyof GuestVerificationCapabilities) {
  return async function requireGuestCapabilityHook(request: FastifyRequest): Promise<void> {
    const guest = request.authGuest;
    if (!guest) {
      throw NOT_AUTHENTICATED;
    }
    if (!guest.capabilities[capability] || !guest.participantId) {
      throw NOT_AUTHORIZED;
    }
  };
}

/**
 * Module 19 — a Guest may only ever act within their own invitation's Incident, never an
 * arbitrary `:id` route param supplied by the client. See
 * claude/prompts/19-participant-management.md, "Incident scope isolation".
 */
export async function requireGuestIncidentMatch(request: FastifyRequest): Promise<void> {
  const guest = request.authGuest;
  if (!guest) {
    throw NOT_AUTHENTICATED;
  }
  const { id } = request.params as { id?: string };
  if (!id || id !== guest.incidentId) {
    throw NOT_AUTHORIZED;
  }
}
