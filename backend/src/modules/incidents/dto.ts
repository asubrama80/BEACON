export type IncidentSeverity = "info" | "warning" | "high" | "critical";
export type IncidentStatus = "open" | "active" | "resolved" | "closed";
export type ParticipantType = "user" | "contact" | "guest";

export interface CommanderSummaryDto {
  id: string;
  displayName: string;
  status: string;
}

/** Explicit response shape — never a raw DB row, never a User/Contact auth field. */
export interface IncidentDto {
  id: string;
  incidentNumber: string;
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  status: IncidentStatus;
  commander: CommanderSummaryDto | null;
  participantCount: number;
  registeredUserCount: number;
  contactParticipantCount: number;
  activatedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentRow {
  id: string;
  incidentNumber: string;
  title: string;
  description: string | null;
  severity: string;
  status: string;
  commanderId: string | null;
  commanderDisplayName: string | null;
  commanderStatus: string | null;
  participantCount: number;
  registeredUserCount: number;
  contactParticipantCount: number;
  activatedAt: Date | null;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toIncidentDto(row: IncidentRow): IncidentDto {
  return {
    id: row.id,
    incidentNumber: row.incidentNumber,
    title: row.title,
    description: row.description,
    severity: row.severity as IncidentSeverity,
    status: row.status as IncidentStatus,
    commander:
      row.commanderId && row.commanderDisplayName
        ? { id: row.commanderId, displayName: row.commanderDisplayName, status: row.commanderStatus ?? "active" }
        : null,
    participantCount: row.participantCount,
    registeredUserCount: row.registeredUserCount,
    contactParticipantCount: row.contactParticipantCount,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A single Incident roster entry — a registered User, a Contact, or a verified Guest, never more
 * than one identity per row. See claude/prompts/19-participant-management.md, "Unified roster". */
export interface ParticipantDto {
  id: string;
  participantType: ParticipantType;
  participantRole: string;
  status: string;
  displayName: string;
  email: string | null;
  mobilePhone: string | null;
  /** The underlying User/Contact's own current status (active/inactive/…) — never hidden. `null`
   * for a Guest, which has no separate identity-level status beyond its own participant row. */
  sourceStatus: string | null;
  /** Guest-only — the invitation's granted capabilities. `null` for User/Contact rows. */
  guestCapabilities: { chat: boolean; warRoom: boolean } | null;
  /** Guest-only — when OTP verification completed. `null` for User/Contact rows, and for a Guest
   * participant row that (in principle) exists before verification. */
  guestVerifiedAt: string | null;
  addedAt: string;
}

export interface ParticipantRow {
  id: string;
  participantType: string;
  participantRole: string;
  status: string;
  userId: string | null;
  contactId: string | null;
  guestInvitationId: string | null;
  userDisplayName: string | null;
  userStatus: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactEmail: string | null;
  contactMobilePhone: string | null;
  contactStatus: string | null;
  guestName: string | null;
  guestInvitationStatus: string | null;
  guestPermissions: unknown;
  guestVerifiedAt: Date | null;
  createdAt: Date;
}

function toGuestCapabilities(raw: unknown): { chat: boolean; warRoom: boolean } {
  const value = (raw ?? {}) as Record<string, unknown>;
  return { chat: value.chat === true, warRoom: value.warRoom === true };
}

export function toParticipantDto(row: ParticipantRow): ParticipantDto {
  if (row.participantType === "user") {
    return {
      id: row.id,
      participantType: "user",
      participantRole: row.participantRole,
      status: row.status,
      displayName: row.userDisplayName ?? "",
      email: null,
      mobilePhone: null,
      sourceStatus: row.userStatus ?? "active",
      guestCapabilities: null,
      guestVerifiedAt: null,
      addedAt: row.createdAt.toISOString(),
    };
  }
  if (row.participantType === "guest") {
    return {
      id: row.id,
      participantType: "guest",
      participantRole: row.participantRole,
      status: row.status,
      // Deliberately the Guest's display name only — never their invitation destination
      // (email/phone), which ordinary roster viewers must never see. See
      // claude/prompts/19-participant-management.md, "Roster privacy".
      displayName: row.guestName ?? "",
      email: null,
      mobilePhone: null,
      sourceStatus: null,
      guestCapabilities: toGuestCapabilities(row.guestPermissions),
      guestVerifiedAt: row.guestVerifiedAt ? row.guestVerifiedAt.toISOString() : null,
      addedAt: row.createdAt.toISOString(),
    };
  }
  return {
    id: row.id,
    participantType: "contact",
    participantRole: row.participantRole,
    status: row.status,
    displayName: `${row.contactFirstName ?? ""} ${row.contactLastName ?? ""}`.trim(),
    email: row.contactEmail,
    mobilePhone: row.contactMobilePhone,
    sourceStatus: row.contactStatus ?? "active",
    guestCapabilities: null,
    guestVerifiedAt: null,
    addedAt: row.createdAt.toISOString(),
  };
}

export interface TimelineEventDto {
  id: string;
  eventType: string;
  actorUserId: string | null;
  actorDisplayName: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface TimelineEventRow {
  id: string;
  eventType: string;
  actorUserId: string | null;
  actorDisplayName: string | null;
  metadata: unknown;
  occurredAt: Date;
}

export function toTimelineEventDto(row: TimelineEventRow): TimelineEventDto {
  return {
    id: row.id,
    eventType: row.eventType,
    actorUserId: row.actorUserId,
    actorDisplayName: row.actorDisplayName,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    occurredAt: row.occurredAt.toISOString(),
  };
}
