export type GuestInvitationStatus = "pending" | "sent" | "verified" | "joined" | "expired" | "revoked";

export interface GuestInvitationCapabilities {
  chat: boolean;
  warRoom: boolean;
}

export interface GuestInvitation {
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

/** Returned only once, immediately after creation — never persisted client-side beyond this response. */
export interface CreateGuestInvitationResult {
  invitation: GuestInvitation;
  invitationUrl: string;
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}

/** The public, pre-verification landing-page projection — deliberately minimal. */
export interface PublicInvitation {
  valid: boolean;
  reason?: "expired" | "revoked" | "not_found" | "incident_not_eligible" | "already_used";
  incidentNumber?: string;
  incidentTitle?: string;
  guestName?: string;
  maskedDestination?: string;
}
