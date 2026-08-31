import { and, eq } from "drizzle-orm";
import { incidents, type Database, type DbOrTx } from "@beacon/database";
import { AuthError } from "../auth/errors.js";
import { recordAuthEvent } from "../auth/audit.js";
import { findSafeUserById } from "../users/userQueries.js";
import { findContactById } from "../contacts/contactQueries.js";
import {
  generateIncidentNumber,
  findIncidentById,
  findIncidentForUpdate,
  listIncidents as queryIncidents,
  normalizePagination as normalizeIncidentPagination,
  type ListIncidentsFilter,
} from "./incidentQueries.js";
import {
  findActiveParticipantByUser,
  findActiveParticipantByContact,
  findActiveParticipantByGuestInvitation,
  insertUserParticipant,
  insertContactParticipant,
  insertGuestParticipant,
  findParticipantRowById,
  softRemoveParticipant,
  listParticipants as queryParticipants,
  normalizePagination as normalizeParticipantPagination,
} from "./participantQueries.js";
import { revokeAllGuestSessionsForInvitation } from "../guestVerification/guestVerificationQueries.js";
import { appendTimelineEvent, listTimeline as queryTimeline, normalizePagination as normalizeTimelinePagination } from "./timelineQueries.js";
import {
  toIncidentDto,
  toParticipantDto,
  toTimelineEventDto,
  type IncidentDto,
  type ParticipantDto,
  type TimelineEventDto,
} from "./dto.js";

const TITLE_MAX_LENGTH = 255;
const DESCRIPTION_MAX_LENGTH = 5000;
const SEVERITIES = ["info", "warning", "high", "critical"] as const;

function validateTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AuthError(400, "invalid_request", "Incident title is required.");
  }
  if (trimmed.length > TITLE_MAX_LENGTH) {
    throw new AuthError(400, "invalid_request", `Incident title must be ${TITLE_MAX_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function validateDescription(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
    throw new AuthError(400, "invalid_request", `Description must be ${DESCRIPTION_MAX_LENGTH} characters or fewer.`);
  }
  return trimmed || null;
}

function validateSeverity(value: string): (typeof SEVERITIES)[number] {
  if (!SEVERITIES.includes(value as (typeof SEVERITIES)[number])) {
    throw new AuthError(400, "invalid_request", `Severity must be one of: ${SEVERITIES.join(", ")}.`);
  }
  return value as (typeof SEVERITIES)[number];
}

async function assertActiveCommanderCandidate(db: Database, userId: string): Promise<void> {
  const user = await findSafeUserById(db, userId);
  if (!user) {
    throw new AuthError(400, "invalid_request", "Commander must be an existing BEACON User.");
  }
  if (user.status !== "active") {
    throw new AuthError(400, "invalid_request", "Commander must be an active BEACON User.");
  }
}

async function loadDto(db: Database, id: string): Promise<IncidentDto> {
  const row = await findIncidentById(db, id);
  if (!row) {
    throw new AuthError(404, "not_found", "Incident not found.");
  }
  return toIncidentDto(row);
}

export interface ListIncidentsOptions {
  search?: string;
  status?: string;
  severity?: string;
  commanderId?: string;
  page?: number;
  pageSize?: number;
}

export interface ListIncidentsResponse {
  items: IncidentDto[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listIncidents(db: Database, options: ListIncidentsOptions): Promise<ListIncidentsResponse> {
  const { page, pageSize } = normalizeIncidentPagination(options.page, options.pageSize);
  const filter: ListIncidentsFilter = { ...options, page, pageSize };
  const result = await queryIncidents(db, filter);
  return { items: result.items.map(toIncidentDto), total: result.total, page, pageSize };
}

export async function getIncident(db: Database, id: string): Promise<IncidentDto> {
  return loadDto(db, id);
}

export interface CreateIncidentInput {
  title: string;
  description?: string;
  severity: string;
  commanderUserId?: string;
}

/**
 * Incident creation, its INCIDENT_CREATED timeline+audit events, and (if a commander was
 * provided) its COMMANDER_ASSIGNED timeline+audit events are all written inside one database
 * transaction — never a partial "Incident exists but its timeline doesn't" state.
 */
export async function createIncident(db: Database, input: CreateIncidentInput, actorId: string): Promise<IncidentDto> {
  const title = validateTitle(input.title);
  const description = validateDescription(input.description) ?? null;
  const severity = validateSeverity(input.severity);

  if (input.commanderUserId) {
    await assertActiveCommanderCandidate(db, input.commanderUserId);
  }

  const incidentId = await db.transaction(async (tx) => {
    const incidentNumber = await generateIncidentNumber(tx);

    const [created] = await tx
      .insert(incidents)
      .values({
        incidentNumber,
        title,
        description,
        severity,
        status: "open",
        incidentCommanderId: input.commanderUserId ?? null,
        createdBy: actorId,
      })
      .returning({ id: incidents.id });
    if (!created) {
      throw new AuthError(500, "not_found", "Incident creation failed unexpectedly.");
    }

    await appendTimelineEvent(tx, {
      incidentId: created.id,
      eventType: "INCIDENT_CREATED",
      actorUserId: actorId,
      metadata: { title, severity },
    });
    await recordAuthEvent(tx, {
      eventType: "INCIDENT_CREATED",
      actorId,
      resourceType: "incident",
      resourceId: created.id,
      incidentId: created.id,
      metadata: { incidentNumber, severity },
    });

    if (input.commanderUserId) {
      await appendTimelineEvent(tx, {
        incidentId: created.id,
        eventType: "COMMANDER_ASSIGNED",
        actorUserId: actorId,
        metadata: { commanderUserId: input.commanderUserId },
      });
      await recordAuthEvent(tx, {
        eventType: "INCIDENT_COMMANDER_ASSIGNED",
        actorId,
        resourceType: "incident",
        resourceId: created.id,
        incidentId: created.id,
        metadata: { commanderUserId: input.commanderUserId },
      });
    }

    return created.id;
  });

  return loadDto(db, incidentId);
}

export interface UpdateIncidentInput {
  title?: string;
  description?: string;
  severity?: string;
}

export async function updateIncident(
  db: Database,
  id: string,
  input: UpdateIncidentInput,
  actorId: string,
): Promise<IncidentDto> {
  await db.transaction(async (tx) => {
    const current = await findIncidentForUpdate(tx, id);
    if (!current) {
      throw new AuthError(404, "not_found", "Incident not found.");
    }
    if (current.status === "closed") {
      throw new AuthError(409, "incident_closed", "This Incident is closed and can no longer be edited.");
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    const changedFields: string[] = [];
    let severityChange: { from: string; to: string } | undefined;

    if (input.title !== undefined) {
      patch.title = validateTitle(input.title);
      changedFields.push("title");
    }
    if (input.description !== undefined) {
      patch.description = validateDescription(input.description);
      changedFields.push("description");
    }
    if (input.severity !== undefined) {
      const newSeverity = validateSeverity(input.severity);
      const [row] = await tx.select({ severity: incidents.severity }).from(incidents).where(eq(incidents.id, id)).limit(1);
      if (row && row.severity !== newSeverity) {
        severityChange = { from: row.severity, to: newSeverity };
        patch.severity = newSeverity;
        changedFields.push("severity");
      }
    }

    if (changedFields.length === 0) return;

    await tx.update(incidents).set(patch).where(eq(incidents.id, id));

    const nonSeverityFields = changedFields.filter((f) => f !== "severity");
    if (nonSeverityFields.length > 0) {
      await appendTimelineEvent(tx, {
        incidentId: id,
        eventType: "INCIDENT_UPDATED",
        actorUserId: actorId,
        metadata: { fields: nonSeverityFields },
      });
      await recordAuthEvent(tx, {
        eventType: "INCIDENT_UPDATED",
        actorId,
        resourceType: "incident",
        resourceId: id,
        incidentId: id,
        metadata: { fields: nonSeverityFields },
      });
    }
    if (severityChange) {
      await appendTimelineEvent(tx, {
        incidentId: id,
        eventType: "SEVERITY_CHANGED",
        actorUserId: actorId,
        metadata: severityChange,
      });
      await recordAuthEvent(tx, {
        eventType: "INCIDENT_SEVERITY_CHANGED",
        actorId,
        resourceType: "incident",
        resourceId: id,
        incidentId: id,
        metadata: severityChange,
      });
    }
  });

  return loadDto(db, id);
}

interface TransitionSpec {
  from: string;
  to: string;
  timelineEvent: string;
  auditEvent: "INCIDENT_ACTIVATED" | "INCIDENT_RESOLVED" | "INCIDENT_REOPENED" | "INCIDENT_CLOSED";
  extraColumns?: (now: Date) => Record<string, unknown>;
}

/**
 * A conditional `UPDATE ... WHERE id = ? AND status = ?` — the affected-row-count check IS the
 * concurrency guard (see claude/prompts/08-incident-management.md, "Concurrency protections"): a
 * stale client that still believes the Incident is ACTIVE can never transition it a second time,
 * because by the time its request runs, `status` is no longer the value the WHERE clause requires.
 */
async function applyTransition(db: Database, id: string, actorId: string, spec: TransitionSpec): Promise<IncidentDto> {
  await db.transaction(async (tx) => {
    const now = new Date();
    const patch: Record<string, unknown> = { status: spec.to, updatedAt: now, ...(spec.extraColumns?.(now) ?? {}) };

    const result = await tx
      .update(incidents)
      .set(patch)
      .where(and(eq(incidents.id, id), eq(incidents.status, spec.from)))
      .returning({ id: incidents.id });

    if (result.length === 0) {
      const [existing] = await tx.select({ id: incidents.id, status: incidents.status }).from(incidents).where(eq(incidents.id, id)).limit(1);
      if (!existing) {
        throw new AuthError(404, "not_found", "Incident not found.");
      }
      throw new AuthError(
        409,
        "invalid_transition",
        `Incident must be ${spec.from.toUpperCase()} to perform this action (currently ${existing.status.toUpperCase()}).`,
      );
    }

    await appendTimelineEvent(tx, { incidentId: id, eventType: spec.timelineEvent, actorUserId: actorId });
    await recordAuthEvent(tx, {
      eventType: spec.auditEvent,
      actorId,
      resourceType: "incident",
      resourceId: id,
      incidentId: id,
    });
  });
  return loadDto(db, id);
}

export async function activateIncident(db: Database, id: string, actorId: string): Promise<IncidentDto> {
  return applyTransition(db, id, actorId, {
    from: "open",
    to: "active",
    timelineEvent: "INCIDENT_ACTIVATED",
    auditEvent: "INCIDENT_ACTIVATED",
    extraColumns: (now) => ({ activatedAt: now }),
  });
}

export async function resolveIncident(db: Database, id: string, actorId: string): Promise<IncidentDto> {
  return applyTransition(db, id, actorId, {
    from: "active",
    to: "resolved",
    timelineEvent: "INCIDENT_RESOLVED",
    auditEvent: "INCIDENT_RESOLVED",
    extraColumns: (now) => ({ resolvedAt: now }),
  });
}

export async function closeIncident(db: Database, id: string, actorId: string): Promise<IncidentDto> {
  return applyTransition(db, id, actorId, {
    from: "resolved",
    to: "closed",
    timelineEvent: "INCIDENT_CLOSED",
    auditEvent: "INCIDENT_CLOSED",
    extraColumns: (now) => ({ closedAt: now }),
  });
}

/**
 * RESOLVED → ACTIVE only — a deliberately narrow reopen path for "marked resolved prematurely."
 * CLOSED remains strictly terminal; there is no transition out of it (see module spec section 8
 * and claude/prompts/08-incident-management.md, "CLOSED semantics").
 */
export async function reopenIncident(db: Database, id: string, actorId: string): Promise<IncidentDto> {
  return applyTransition(db, id, actorId, {
    from: "resolved",
    to: "active",
    timelineEvent: "INCIDENT_REOPENED",
    auditEvent: "INCIDENT_REOPENED",
    extraColumns: () => ({ resolvedAt: null }),
  });
}

export async function assignCommander(db: Database, id: string, userId: string, actorId: string): Promise<IncidentDto> {
  await assertActiveCommanderCandidate(db, userId);

  await db.transaction(async (tx) => {
    const current = await findIncidentForUpdate(tx, id);
    if (!current) {
      throw new AuthError(404, "not_found", "Incident not found.");
    }
    if (current.status === "closed") {
      throw new AuthError(409, "incident_closed", "This Incident is closed; its commander can no longer be changed.");
    }

    const isChange = current.incidentCommanderId !== null && current.incidentCommanderId !== userId;
    if (current.incidentCommanderId === userId) {
      return;
    }

    await tx.update(incidents).set({ incidentCommanderId: userId, updatedAt: new Date() }).where(eq(incidents.id, id));

    const timelineEvent = isChange ? "COMMANDER_CHANGED" : "COMMANDER_ASSIGNED";
    const auditEvent = isChange ? "INCIDENT_COMMANDER_CHANGED" : "INCIDENT_COMMANDER_ASSIGNED";
    await appendTimelineEvent(tx, {
      incidentId: id,
      eventType: timelineEvent,
      actorUserId: actorId,
      metadata: { commanderUserId: userId },
    });
    await recordAuthEvent(tx, {
      eventType: auditEvent,
      actorId,
      resourceType: "incident",
      resourceId: id,
      incidentId: id,
      metadata: { commanderUserId: userId },
    });
  });

  return loadDto(db, id);
}

export interface ListParticipantsOptions {
  page?: number;
  pageSize?: number;
}

export interface ListParticipantsResponse {
  items: ParticipantDto[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listParticipants(
  db: Database,
  incidentId: string,
  options: ListParticipantsOptions,
): Promise<ListParticipantsResponse> {
  const incident = await findIncidentById(db, incidentId);
  if (!incident) {
    throw new AuthError(404, "not_found", "Incident not found.");
  }
  const { page, pageSize } = normalizeParticipantPagination(options.page, options.pageSize);
  const result = await queryParticipants(db, incidentId, { page, pageSize });
  return { items: result.items.map(toParticipantDto), total: result.total, page, pageSize };
}

async function assertIncidentOpenForRoster(tx: DbOrTx, id: string): Promise<void> {
  const current = await findIncidentForUpdate(tx, id);
  if (!current) {
    throw new AuthError(404, "not_found", "Incident not found.");
  }
  if (current.status === "closed") {
    throw new AuthError(409, "incident_closed", "This Incident is closed; its participant roster can no longer change.");
  }
}

export async function addUserParticipant(db: Database, incidentId: string, userId: string, actorId: string): Promise<void> {
  const user = await findSafeUserById(db, userId);
  if (!user) {
    throw new AuthError(404, "not_found", "User not found.");
  }
  if (user.status !== "active") {
    throw new AuthError(400, "invalid_request", "An inactive User cannot be newly added as a participant.");
  }

  await db.transaction(async (tx) => {
    await assertIncidentOpenForRoster(tx, incidentId);

    const existing = await findActiveParticipantByUser(tx, incidentId, userId);
    if (existing) {
      throw new AuthError(409, "duplicate_participant", "This User is already a participant on this Incident.");
    }

    await insertUserParticipant(tx, incidentId, userId);

    await appendTimelineEvent(tx, {
      incidentId,
      eventType: "PARTICIPANT_ADDED",
      actorUserId: actorId,
      metadata: { participantType: "user", userId },
    });
    await recordAuthEvent(tx, {
      eventType: "INCIDENT_PARTICIPANT_ADDED",
      actorId,
      resourceType: "incident",
      resourceId: incidentId,
      incidentId,
      metadata: { participantType: "user", userId },
    });
  });
}

export async function addContactParticipant(
  db: Database,
  incidentId: string,
  contactId: string,
  actorId: string,
): Promise<void> {
  const contact = await findContactById(db, contactId);
  if (!contact) {
    throw new AuthError(404, "not_found", "Contact not found.");
  }
  if (contact.status !== "active") {
    throw new AuthError(400, "invalid_request", "An inactive Contact cannot be newly added as a participant.");
  }

  await db.transaction(async (tx) => {
    await assertIncidentOpenForRoster(tx, incidentId);

    const existing = await findActiveParticipantByContact(tx, incidentId, contactId);
    if (existing) {
      throw new AuthError(409, "duplicate_participant", "This Contact is already a participant on this Incident.");
    }

    await insertContactParticipant(tx, incidentId, contactId);

    await appendTimelineEvent(tx, {
      incidentId,
      eventType: "PARTICIPANT_ADDED",
      actorUserId: actorId,
      metadata: { participantType: "contact", contactId },
    });
    await recordAuthEvent(tx, {
      eventType: "INCIDENT_PARTICIPANT_ADDED",
      actorId,
      resourceType: "incident",
      resourceId: incidentId,
      incidentId,
      metadata: { participantType: "contact", contactId },
    });
  });
}

/**
 * Soft removal (status → 'removed') — never a hard delete. See module doc, "Participant model".
 * For a Guest participant (Module 19), also eagerly revokes every active Guest session for the
 * underlying invitation in the same transaction — see
 * claude/prompts/19-participant-management.md, "Removal revokes access".
 */
export async function removeParticipant(
  db: Database,
  incidentId: string,
  participantId: string,
  actorId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await assertIncidentOpenForRoster(tx, incidentId);

    const participant = await findParticipantRowById(tx, incidentId, participantId);
    if (!participant || participant.status === "removed") {
      throw new AuthError(404, "not_found", "Participant not found.");
    }

    await softRemoveParticipant(tx, participantId);

    if (participant.participantType === "guest" && participant.guestInvitationId) {
      await revokeAllGuestSessionsForInvitation(tx, participant.guestInvitationId);
      await recordAuthEvent(tx, {
        eventType: "GUEST_ACCESS_REVOKED",
        actorId,
        resourceType: "guest_invitation",
        resourceId: participant.guestInvitationId,
        incidentId,
        metadata: { reason: "participant_removed" },
      });
    }

    await appendTimelineEvent(tx, {
      incidentId,
      eventType: "PARTICIPANT_REMOVED",
      actorUserId: actorId,
      metadata: { participantId },
    });
    await recordAuthEvent(tx, {
      eventType: "INCIDENT_PARTICIPANT_REMOVED",
      actorId,
      resourceType: "incident",
      resourceId: incidentId,
      incidentId,
      metadata: { participantId },
    });
  });
}

/**
 * Module 19 — auto-enrolls a just-verified Guest into the Incident roster. Called from
 * `guestVerificationService.verifyOtp()` inside the SAME transaction as `markInvitationVerified()`,
 * gated on that function's own first-time-only return value — so this is only ever reached once
 * per invitation, on the winning side of a concurrent-verification race. The
 * `incident_participants_active_guest_idx` partial unique index is the real duplicate guarantee;
 * the pre-check here only avoids an unnecessary insert attempt.
 */
export async function enrollVerifiedGuestParticipant(tx: DbOrTx, incidentId: string, guestInvitationId: string): Promise<void> {
  const existing = await findActiveParticipantByGuestInvitation(tx, incidentId, guestInvitationId);
  if (existing) return;
  await insertGuestParticipant(tx, incidentId, guestInvitationId);
}

export interface ListTimelineOptions {
  page?: number;
  pageSize?: number;
  order?: "asc" | "desc";
}

export interface ListTimelineResponse {
  items: TimelineEventDto[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listTimeline(
  db: Database,
  incidentId: string,
  options: ListTimelineOptions,
): Promise<ListTimelineResponse> {
  const incident = await findIncidentById(db, incidentId);
  if (!incident) {
    throw new AuthError(404, "not_found", "Incident not found.");
  }
  const { page, pageSize } = normalizeTimelinePagination(options.page, options.pageSize);
  const result = await queryTimeline(db, incidentId, { page, pageSize, order: options.order });
  return { items: result.items.map(toTimelineEventDto), total: result.total, page, pageSize };
}
