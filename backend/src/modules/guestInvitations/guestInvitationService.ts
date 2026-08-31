import type { Database } from "@beacon/database";
import { AuthError } from "../auth/errors.js";
import { recordAuthEvent } from "../auth/audit.js";
import { appendTimelineEvent } from "../incidents/timelineQueries.js";
import { findIncidentById } from "../incidents/incidentQueries.js";
import { normalizeEmail, normalizePhone } from "../contacts/normalization.js";
import type { NotificationConfig } from "../notifications/config.js";
import type { GuestInvitationConfig } from "./config.js";
import { generateInvitationToken, hashInvitationToken } from "./token.js";
import { buildInvitationUrl, sendGuestInvitationNotification } from "./guestNotify.js";
import {
  insertInvitation,
  markInvitationSent,
  findInvitationRow,
  listInvitationsForIncident,
  findActiveInvitation,
  revokeInvitationRow,
  findPublicInvitationByTokenHash,
} from "./guestInvitationQueries.js";
import {
  toGuestInvitationDto,
  type GuestInvitationDto,
  type CreateGuestInvitationResult,
  type PublicInvitationDto,
} from "./guestInvitationDto.js";

async function assertIncidentOpenForInvites(db: Database, incidentId: string): Promise<void> {
  const incident = await findIncidentById(db, incidentId);
  if (!incident) {
    throw new AuthError(404, "not_found", "Incident not found.");
  }
  if (incident.status === "closed") {
    throw new AuthError(409, "incident_closed", "This Incident is closed; a guest cannot be invited.");
  }
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***";
  const visible = local.slice(0, 1);
  return `${visible}${"*".repeat(Math.max(local.length - 1, 3))}@${domain}`;
}

function maskPhone(phone: string): string {
  const last4 = phone.slice(-4);
  return `***-***-${last4}`;
}

export interface CreateInvitationInput {
  incidentId: string;
  guestName: string;
  email?: string | null;
  mobilePhone?: string | null;
  capabilities: { chat: boolean; warRoom: boolean };
  invitedBy: string;
}

/**
 * A guest invitation never touches the `users`/`user_roles` tables — the guest gains no BEACON
 * account, password, or RBAC role at any point in this flow. See claude/prompts/17-guest-invitations.md,
 * "Guest vs User boundary".
 */
export async function createInvitation(
  db: Database,
  guestInvitationConfig: GuestInvitationConfig,
  notificationConfig: NotificationConfig,
  input: CreateInvitationInput,
): Promise<CreateGuestInvitationResult> {
  await assertIncidentOpenForInvites(db, input.incidentId);

  let email: string | null = null;
  let mobilePhone: string | null = null;

  if (input.email) {
    const normalized = normalizeEmail(input.email);
    if (!normalized.valid || !normalized.value) {
      throw new AuthError(400, "invalid_request", normalized.reason ?? "Email is invalid.");
    }
    email = normalized.value;
  }
  if (input.mobilePhone) {
    const normalized = normalizePhone(input.mobilePhone);
    if (!normalized.valid || !normalized.value) {
      throw new AuthError(400, "invalid_request", normalized.reason ?? "Phone number is invalid.");
    }
    mobilePhone = normalized.value;
  }
  if (!email && !mobilePhone) {
    throw new AuthError(400, "invalid_request", "An email or mobile phone destination is required.");
  }

  const rawToken = generateInvitationToken();
  const tokenHash = hashInvitationToken(rawToken);
  const expiresAt = new Date(Date.now() + guestInvitationConfig.ttlHours * 60 * 60 * 1000);

  // Pre-check inside the same transaction as the insert (mirrors Module 08's participant-add
  // pattern) gives a clean 409 in the common case; the partial unique indexes on
  // `guest_invitations` are the real race-safety net for two concurrent requests that both pass
  // the pre-check. See claude/prompts/17-guest-invitations.md, "Duplicate invitations".
  const id = await db.transaction(async (tx) => {
    const existing = await findActiveInvitation(tx, input.incidentId, { email, mobilePhone });
    if (existing) {
      throw new AuthError(409, "invitation_already_active", "An active guest invitation already exists for this destination on this Incident.", {
        invitationId: existing.id,
      });
    }
    return (
      await insertInvitation(tx, {
        incidentId: input.incidentId,
        guestName: input.guestName,
        email,
        mobilePhone,
        tokenHash,
        capabilities: input.capabilities,
        expiresAt,
        invitedBy: input.invitedBy,
      })
    ).id;
  });

  const invitationUrl = buildInvitationUrl(guestInvitationConfig, rawToken);
  const incident = await findIncidentById(db, input.incidentId);

  await recordAuthEvent(db, {
    eventType: "GUEST_INVITATION_CREATED",
    actorId: input.invitedBy,
    resourceType: "guest_invitation",
    resourceId: id,
    incidentId: input.incidentId,
    metadata: { channel: email ? "email" : "sms", capabilities: input.capabilities },
  });
  await appendTimelineEvent(db, {
    incidentId: input.incidentId,
    eventType: "GUEST_INVITED",
    actorUserId: input.invitedBy,
  });

  const delivered = await sendGuestInvitationNotification(notificationConfig, {
    invitationId: id,
    guestName: input.guestName,
    email,
    mobilePhone,
    incidentTitle: incident?.title ?? "Incident",
    invitationUrl,
  });
  if (delivered) {
    await markInvitationSent(db, id);
    await recordAuthEvent(db, {
      eventType: "GUEST_INVITATION_SENT",
      actorId: input.invitedBy,
      resourceType: "guest_invitation",
      resourceId: id,
      incidentId: input.incidentId,
      metadata: { channel: email ? "email" : "sms" },
    });
  }

  const row = await findInvitationRow(db, input.incidentId, id);
  if (!row) throw new Error("Failed to load guest invitation after creation.");
  return { invitation: toGuestInvitationDto(row), invitationUrl };
}

export async function listInvitations(db: Database, incidentId: string): Promise<GuestInvitationDto[]> {
  const incident = await findIncidentById(db, incidentId);
  if (!incident) throw new AuthError(404, "not_found", "Incident not found.");
  const rows = await listInvitationsForIncident(db, incidentId);
  return rows.map(toGuestInvitationDto);
}

export async function getInvitation(db: Database, incidentId: string, invitationId: string): Promise<GuestInvitationDto> {
  const row = await findInvitationRow(db, incidentId, invitationId);
  if (!row) throw new AuthError(404, "not_found", "Guest invitation not found.");
  return toGuestInvitationDto(row);
}

export async function revokeInvitation(db: Database, incidentId: string, invitationId: string, actorId: string): Promise<GuestInvitationDto> {
  const row = await findInvitationRow(db, incidentId, invitationId);
  if (!row) throw new AuthError(404, "not_found", "Guest invitation not found.");

  const revoked = await revokeInvitationRow(db, invitationId, actorId);
  if (revoked) {
    await recordAuthEvent(db, {
      eventType: "GUEST_INVITATION_REVOKED",
      actorId,
      resourceType: "guest_invitation",
      resourceId: invitationId,
      incidentId,
    });
  }

  const updated = await findInvitationRow(db, incidentId, invitationId);
  if (!updated) throw new AuthError(404, "not_found", "Guest invitation not found.");
  return toGuestInvitationDto(updated);
}

/**
 * The public, unauthenticated landing-page lookup. Deliberately returns the same generic
 * `{valid:false}` shape for "token doesn't exist" and "token is malformed" — never lets a caller
 * distinguish a guessed-wrong token from a real-but-expired one beyond the single safe `reason`
 * field, and never echoes back anything the caller didn't already prove possession of via the
 * token itself. See claude/prompts/17-guest-invitations.md, "Public invitation lookup".
 */
export async function getPublicInvitation(db: Database, rawToken: string): Promise<PublicInvitationDto> {
  const tokenHash = hashInvitationToken(rawToken);
  const row = await findPublicInvitationByTokenHash(db, tokenHash);
  if (!row) {
    return { valid: false, reason: "not_found" };
  }
  if (row.revokedAt || row.status === "revoked") {
    return { valid: false, reason: "revoked" };
  }
  if (row.expiresAt.getTime() < Date.now() || row.status === "expired") {
    return { valid: false, reason: "expired" };
  }
  if (row.incidentStatus === "closed") {
    return { valid: false, reason: "incident_not_eligible" };
  }
  if (row.status === "verified" || row.status === "joined") {
    return { valid: false, reason: "already_used" };
  }

  // The `guest_invitations_contact_method_check` DB constraint guarantees at least one of
  // email/mobilePhone is set, so this always produces a real masked value in practice.
  const maskedDestination = row.email ? maskEmail(row.email) : row.mobilePhone ? maskPhone(row.mobilePhone) : "";

  return {
    valid: true,
    incidentNumber: row.incidentNumber,
    incidentTitle: row.incidentTitle,
    guestName: row.guestName,
    maskedDestination,
  };
}
