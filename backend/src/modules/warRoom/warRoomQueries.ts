import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, sql } from "drizzle-orm";
import { incidentWarRooms, warRoomSessions, users, type Database, type DbOrTx } from "@beacon/database";
import type { WarRoomRow, WarRoomSessionRow } from "./warRoomDto.js";

const openedByUsers = alias(users, "opened_by_users");
const endedByUsers = alias(users, "ended_by_users");

/** Most recent War Room for an Incident, regardless of status — "not_started" is the absence of
 * any row at all, so callers treat `undefined` as that case. */
export async function findLatestWarRoom(db: DbOrTx, incidentId: string): Promise<WarRoomRow | undefined> {
  const [row] = await db
    .select({
      id: incidentWarRooms.id,
      status: incidentWarRooms.status,
      openedByDisplayName: openedByUsers.displayName,
      openedAt: incidentWarRooms.openedAt,
      endedByDisplayName: endedByUsers.displayName,
      endedAt: incidentWarRooms.endedAt,
    })
    .from(incidentWarRooms)
    .leftJoin(openedByUsers, eq(openedByUsers.id, incidentWarRooms.openedByUserId))
    .leftJoin(endedByUsers, eq(endedByUsers.id, incidentWarRooms.endedByUserId))
    .where(eq(incidentWarRooms.incidentId, incidentId))
    .orderBy(desc(incidentWarRooms.createdAt))
    .limit(1);
  return row;
}

export async function findActiveWarRoom(db: DbOrTx, incidentId: string): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: incidentWarRooms.id })
    .from(incidentWarRooms)
    .where(and(eq(incidentWarRooms.incidentId, incidentId), eq(incidentWarRooms.status, "open")))
    .limit(1);
  return row;
}

export async function insertWarRoom(db: DbOrTx, incidentId: string, actorId: string): Promise<{ id: string }> {
  const [row] = await db
    .insert(incidentWarRooms)
    .values({ incidentId, status: "open", openedByUserId: actorId })
    .returning({ id: incidentWarRooms.id });
  if (!row) throw new Error("Failed to open War Room.");
  return row;
}

/** Conditional UPDATE — the real concurrency guard against a double-end race, not just a
 * courtesy check. Zero affected rows means someone else already ended it (or it was never open). */
export async function endWarRoomRow(db: DbOrTx, warRoomId: string, actorId: string): Promise<boolean> {
  const result = await db
    .update(incidentWarRooms)
    .set({ status: "ended", endedAt: new Date(), endedByUserId: actorId, updatedAt: new Date() })
    .where(and(eq(incidentWarRooms.id, warRoomId), eq(incidentWarRooms.status, "open")))
    .returning({ id: incidentWarRooms.id });
  return result.length > 0;
}

export async function countActiveSessions(db: DbOrTx, warRoomId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(warRoomSessions)
    .where(and(eq(warRoomSessions.warRoomId, warRoomId), eq(warRoomSessions.status, "joined")));
  return row?.count ?? 0;
}

export async function findActiveSession(db: DbOrTx, warRoomId: string, userId: string): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: warRoomSessions.id })
    .from(warRoomSessions)
    .where(and(eq(warRoomSessions.warRoomId, warRoomId), eq(warRoomSessions.userId, userId), eq(warRoomSessions.status, "joined")))
    .limit(1);
  return row;
}

export async function insertSession(db: DbOrTx, warRoomId: string, userId: string): Promise<{ id: string }> {
  const [row] = await db
    .insert(warRoomSessions)
    .values({ warRoomId, participantType: "user", userId, status: "joined" })
    .returning({ id: warRoomSessions.id });
  if (!row) throw new Error("Failed to create a War Room session.");
  return row;
}

/** Idempotent — zero affected rows if the session was already left (or never existed). */
export async function endSession(db: DbOrTx, sessionId: string): Promise<void> {
  await db
    .update(warRoomSessions)
    .set({ status: "left", leftAt: new Date() })
    .where(and(eq(warRoomSessions.id, sessionId), eq(warRoomSessions.status, "joined")));
}

/** Bulk session cleanup when a room ends — no one stays "joined" to an ended room. */
export async function endAllActiveSessions(db: DbOrTx, warRoomId: string): Promise<void> {
  await db
    .update(warRoomSessions)
    .set({ status: "left", leftAt: new Date() })
    .where(and(eq(warRoomSessions.warRoomId, warRoomId), eq(warRoomSessions.status, "joined")));
}

export async function listSessions(db: Database, warRoomId: string): Promise<WarRoomSessionRow[]> {
  return db
    .select({
      id: warRoomSessions.id,
      userId: warRoomSessions.userId,
      displayName: users.displayName,
      status: warRoomSessions.status,
      joinedAt: warRoomSessions.joinedAt,
      leftAt: warRoomSessions.leftAt,
    })
    .from(warRoomSessions)
    .leftJoin(users, eq(users.id, warRoomSessions.userId))
    .where(eq(warRoomSessions.warRoomId, warRoomId))
    .orderBy(desc(warRoomSessions.joinedAt));
}
