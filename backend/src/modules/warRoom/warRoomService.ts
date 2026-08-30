import type { Database } from "@beacon/database";
import { AuthError } from "../auth/errors.js";
import { recordAuthEvent } from "../auth/audit.js";
import { appendTimelineEvent } from "../incidents/timelineQueries.js";
import { findIncidentById } from "../incidents/incidentQueries.js";
import {
  findLatestWarRoom,
  findActiveWarRoom,
  insertWarRoom,
  endWarRoomRow,
  countActiveSessions,
  findActiveSession,
  insertSession,
  endSession,
  endAllActiveSessions,
  listSessions as queryListSessions,
} from "./warRoomQueries.js";
import { toWarRoomDto, toWarRoomSessionDto, type WarRoomDto, type WarRoomSessionDto } from "./warRoomDto.js";

async function assertIncidentExists(db: Database, incidentId: string): Promise<{ status: string }> {
  const incident = await findIncidentById(db, incidentId);
  if (!incident) {
    throw new AuthError(404, "not_found", "Incident not found.");
  }
  return incident;
}

export async function getWarRoom(db: Database, incidentId: string): Promise<WarRoomDto> {
  await assertIncidentExists(db, incidentId);
  const row = await findLatestWarRoom(db, incidentId);
  const activeSessionCount = row && row.status === "open" ? await countActiveSessions(db, row.id) : 0;
  return toWarRoomDto(row, activeSessionCount);
}

/**
 * Opening is blocked on a CLOSED Incident (no new operational activity may begin) — see module
 * doc, "CLOSED Incident rule". The partial unique index on `(incident_id) WHERE status = 'open'`
 * is the real duplicate-open guarantee; this pre-check only produces a clean error message.
 */
export async function openWarRoom(db: Database, incidentId: string, actorId: string): Promise<WarRoomDto> {
  const incident = await assertIncidentExists(db, incidentId);
  if (incident.status === "closed") {
    throw new AuthError(409, "incident_closed", "This Incident is closed; a War Room cannot be opened.");
  }
  const existing = await findActiveWarRoom(db, incidentId);
  if (existing) {
    throw new AuthError(409, "war_room_already_open", "This Incident's War Room is already open.");
  }

  await db.transaction(async (tx) => {
    await insertWarRoom(tx, incidentId, actorId);
    await appendTimelineEvent(tx, { incidentId, eventType: "WAR_ROOM_OPENED", actorUserId: actorId });
    await recordAuthEvent(tx, { eventType: "WAR_ROOM_OPENED", actorId, resourceType: "incident", resourceId: incidentId, incidentId });
  });

  return getWarRoom(db, incidentId);
}

/**
 * Ending is deliberately **not** blocked by a CLOSED Incident — see module doc, "CLOSED Incident
 * rule" for why: Module 08's `closeIncident()` is never touched by this module (an invasive
 * cross-module change), so a War Room can in principle still be OPEN when its Incident closes.
 * Allowing End to proceed regardless lets an authorized operator clean up a stray open room
 * rather than leaving it permanently stuck open.
 */
export async function endWarRoom(db: Database, incidentId: string, actorId: string): Promise<WarRoomDto> {
  await assertIncidentExists(db, incidentId);
  const active = await findActiveWarRoom(db, incidentId);
  if (!active) {
    throw new AuthError(409, "war_room_not_open", "This Incident has no open War Room to end.");
  }

  await db.transaction(async (tx) => {
    const ended = await endWarRoomRow(tx, active.id, actorId);
    if (!ended) {
      // Lost a race against a concurrent End call — nothing further to do, not an error.
      return;
    }
    const sessionCountBeforeCleanup = await countActiveSessions(tx, active.id);
    await endAllActiveSessions(tx, active.id);
    await appendTimelineEvent(tx, {
      incidentId,
      eventType: "WAR_ROOM_ENDED",
      actorUserId: actorId,
      metadata: { activeSessionsAtEnd: sessionCountBeforeCleanup },
    });
    await recordAuthEvent(tx, {
      eventType: "WAR_ROOM_ENDED",
      actorId,
      resourceType: "incident",
      resourceId: incidentId,
      incidentId,
      metadata: { activeSessionsAtEnd: sessionCountBeforeCleanup },
    });
  });

  return getWarRoom(db, incidentId);
}

/**
 * Join eligibility (see module doc, "Join eligibility"): authenticated + `incidents.war_room.join`
 * (checked by the route, not here) + Incident not CLOSED + room OPEN. Deliberately does **not**
 * require the joiner to already be on the Incident's participant roster — the current
 * authorization model is global, matching every other permission in this codebase; no row-level
 * "assigned incident" concept exists yet. Idempotent: a second Join by the same already-active
 * User returns their existing session rather than erroring or creating a duplicate.
 */
export async function joinWarRoom(db: Database, incidentId: string, userId: string): Promise<WarRoomDto> {
  const incident = await assertIncidentExists(db, incidentId);
  if (incident.status === "closed") {
    throw new AuthError(409, "incident_closed", "This Incident is closed; its War Room can no longer be joined.");
  }
  const active = await findActiveWarRoom(db, incidentId);
  if (!active) {
    throw new AuthError(409, "war_room_not_open", "This Incident has no open War Room to join.");
  }

  const existingSession = await findActiveSession(db, active.id, userId);
  if (!existingSession) {
    await insertSession(db, active.id, userId);
  }

  return getWarRoom(db, incidentId);
}

/** Idempotent — leaving when not currently joined (or when no room is open at all) is a safe
 * no-op, never an error; a browser tab closing uncleanly cannot be perfectly detected, so Leave
 * must tolerate being called redundantly or too late. */
export async function leaveWarRoom(db: Database, incidentId: string, userId: string): Promise<WarRoomDto> {
  await assertIncidentExists(db, incidentId);
  const active = await findActiveWarRoom(db, incidentId);
  if (active) {
    const existingSession = await findActiveSession(db, active.id, userId);
    if (existingSession) {
      await endSession(db, existingSession.id);
    }
  }
  return getWarRoom(db, incidentId);
}

export async function listWarRoomSessions(db: Database, incidentId: string): Promise<WarRoomSessionDto[]> {
  await assertIncidentExists(db, incidentId);
  const room = await findLatestWarRoom(db, incidentId);
  if (!room) return [];
  const rows = await queryListSessions(db, room.id);
  return rows.map(toWarRoomSessionDto);
}
