export type GuestInvitationStatus = "pending" | "sent" | "verified" | "joined" | "expired" | "revoked";

/** Foundation capability toggles — explicit booleans, never translated into an RBAC role/permission. */
export interface GuestInvitationCapabilities {
  chat: boolean;
  warRoom: boolean;
}

function toCapabilities(raw: unknown): GuestInvitationCapabilities {
  const value = (raw ?? {}) as Record<string, unknown>;
  return { chat: value.chat === true, warRoom: value.warRoom === true };
}

/** The authorized-manager view — full record, but still never the token or its hash. */
export interface GuestInvitationDto {
  id: string;
  incidentId: string;
  guestName: string;
  email: string | null;
  mobilePhone: string | null;
  status: GuestInvitationStatus;
  capabilities: GuestInvitationCapabilities;
  expiresAt: string;
  verifiedAt: string | null;
  joinedAt: string | null;
  revokedAt: string | null;
  revokedByDisplayName: string | null;
  invitedByDisplayName: string | null;
  createdAt: string;
}

export interface GuestInvitationRow {
  id: string;
  incidentId: string;
  guestName: string;
  email: string | null;
  mobilePhone: string | null;
  status: string;
  permissions: unknown;
  expiresAt: Date;
  verifiedAt: Date | null;
  joinedAt: Date | null;
  revokedAt: Date | null;
  revokedByDisplayName: string | null;
  invitedByDisplayName: string | null;
  createdAt: Date;
}

export function toGuestInvitationDto(row: GuestInvitationRow): GuestInvitationDto {
  return {
    id: row.id,
    incidentId: row.incidentId,
    guestName: row.guestName,
    email: row.email,
    mobilePhone: row.mobilePhone,
    status: row.status as GuestInvitationStatus,
    capabilities: toCapabilities(row.permissions),
    expiresAt: row.expiresAt.toISOString(),
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    joinedAt: row.joinedAt ? row.joinedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    revokedByDisplayName: row.revokedByDisplayName,
    invitedByDisplayName: row.invitedByDisplayName,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Returned only once, immediately after creation — the sole moment the raw link is available. */
export interface CreateGuestInvitationResult {
  invitation: GuestInvitationDto;
  invitationUrl: string;
}

/**
 * The PUBLIC pre-verification landing-page projection — deliberately minimal. Never includes the
 * inviter, other participants, the full destination, or any internal id beyond what the guest
 * link itself already discloses. See claude/prompts/17-guest-invitations.md, "Public invitation
 * lookup".
 */
export interface PublicInvitationDto {
  valid: boolean;
  reason?: "expired" | "revoked" | "not_found" | "incident_not_eligible" | "already_used";
  incidentNumber?: string;
  incidentTitle?: string;
  guestName?: string;
  maskedDestination?: string;
}
