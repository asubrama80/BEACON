/**
 * Integration tests for Module 14's provider-neutral War Room foundation, run end-to-end against
 * a live PostgreSQL database. Skipped when DATABASE_URL isn't reachable. Runs sequentially with
 * other backend test files (`fileParallelism: false`).
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, users, roles, userRoles, incidents, incidentWarRooms, warRoomSessions, incidentTimelineEvents, auditLogs, type Database } from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("war room routes (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C14";
  const createdUserIds: string[] = [];
  const createdIncidentIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode: string): Promise<{ id: string; token: string; csrf: string }> {
    const email = `test-warroom-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `War Room Test ${roleCode}`, passwordHash })
      .returning({ id: users.id });
    createdUserIds.push(row!.id);
    await db.insert(userRoles).values({ userId: row!.id, roleId: await roleId(roleCode) });

    const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: testPassword } });
    if (response.statusCode !== 200) {
      throw new Error(`login failed for ${roleCode}: ${response.statusCode} ${response.body}`);
    }
    return {
      id: row!.id,
      token: response.cookies.find((c) => c.name === config.sessionCookieName)!.value,
      csrf: response.cookies.find((c) => c.name === config.csrfCookieName)!.value,
    };
  }

  function authHeaders(session: { token: string; csrf: string }) {
    return {
      cookies: { [config.sessionCookieName]: session.token, [config.csrfCookieName]: session.csrf },
      headers: { "x-csrf-token": session.csrf },
    };
  }

  let admin: { id: string; token: string; csrf: string };
  let incidentCommander: { id: string; token: string; csrf: string };
  let responder: { id: string; token: string; csrf: string };
  let auditor: { id: string; token: string; csrf: string };

  beforeAll(async () => {
    admin = await createActor("ADMIN");
    incidentCommander = await createActor("INCIDENT_COMMANDER");
    responder = await createActor("RESPONDER");
    auditor = await createActor("AUDITOR");
  });

  afterAll(async () => {
    for (const id of createdIncidentIds) {
      await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
      await db.delete(incidentTimelineEvents).where(eq(incidentTimelineEvents.incidentId, id));
      const rooms = await db.select({ id: incidentWarRooms.id }).from(incidentWarRooms).where(eq(incidentWarRooms.incidentId, id));
      for (const room of rooms) {
        await db.delete(warRoomSessions).where(eq(warRoomSessions.warRoomId, room.id));
      }
      await db.delete(incidentWarRooms).where(eq(incidentWarRooms.incidentId, id));
      await db.delete(incidents).where(eq(incidents.id, id));
    }
    for (const id of createdUserIds) {
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
      await db.delete(users).where(eq(users.id, id));
    }
    await app.close();
  });

  async function createRawIncident(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/incidents",
      ...authHeaders(admin),
      payload: { title: `War Room Test Incident ${tag}-${randomUUID().slice(0, 6)}`, severity: "warning" },
    });
    const id = response.json().incident.id as string;
    createdIncidentIds.push(id);
    return id;
  }

  async function activateIncident(incidentId: string): Promise<void> {
    await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(admin) });
  }

  async function closeIncident(incidentId: string): Promise<void> {
    await app.inject({ method: "POST", url: `/incidents/${incidentId}/resolve`, ...authHeaders(admin) });
    await app.inject({ method: "POST", url: `/incidents/${incidentId}/close`, ...authHeaders(admin) });
  }

  function getWarRoom(incidentId: string, actor = admin) {
    return app.inject({ method: "GET", url: `/incidents/${incidentId}/war-room`, ...authHeaders(actor) });
  }
  function openWarRoom(incidentId: string, actor = admin) {
    return app.inject({ method: "POST", url: `/incidents/${incidentId}/war-room/open`, ...authHeaders(actor) });
  }
  function joinWarRoom(incidentId: string, actor: { token: string; csrf: string }) {
    return app.inject({ method: "POST", url: `/incidents/${incidentId}/war-room/join`, ...authHeaders(actor) });
  }
  function leaveWarRoom(incidentId: string, actor: { token: string; csrf: string }) {
    return app.inject({ method: "POST", url: `/incidents/${incidentId}/war-room/leave`, ...authHeaders(actor) });
  }
  function endWarRoom(incidentId: string, actor = admin) {
    return app.inject({ method: "POST", url: `/incidents/${incidentId}/war-room/end`, ...authHeaders(actor) });
  }
  function listSessions(incidentId: string, actor = admin) {
    return app.inject({ method: "GET", url: `/incidents/${incidentId}/war-room/sessions`, ...authHeaders(actor) });
  }

  describe("lifecycle", () => {
    it("reports not_started before any room is opened", async () => {
      const incidentId = await createRawIncident();
      const response = await getWarRoom(incidentId);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "not_started", id: null, activeSessionCount: 0 });
    });

    it("opens a room and rejects a duplicate open", async () => {
      const incidentId = await createRawIncident();
      const first = await openWarRoom(incidentId);
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ status: "open" });

      const duplicate = await openWarRoom(incidentId);
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json().error).toBe("war_room_already_open");
    });

    it("never exposes any meeting URL, provider name, or media token", async () => {
      const incidentId = await createRawIncident();
      await openWarRoom(incidentId);
      const response = await getWarRoom(incidentId);
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toMatch(/url|token|provider|meetingId|roomUrl/i);
    });

    it("ends an open room, idempotently cleans up sessions, and rejects further joins", async () => {
      const incidentId = await createRawIncident();
      await openWarRoom(incidentId);
      await joinWarRoom(incidentId, responder);

      const ended = await endWarRoom(incidentId);
      expect(ended.statusCode).toBe(200);
      expect(ended.json()).toMatchObject({ status: "ended", activeSessionCount: 0 });

      const joinAfterEnd = await joinWarRoom(incidentId, responder);
      expect(joinAfterEnd.statusCode).toBe(409);
      expect(joinAfterEnd.json().error).toBe("war_room_not_open");
    });

    it("rejects ending an Incident's War Room when none is open", async () => {
      const incidentId = await createRawIncident();
      const response = await endWarRoom(incidentId);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("war_room_not_open");
    });
  });

  describe("join / leave", () => {
    it("joins, is idempotent on repeated join, and increments activeSessionCount only once", async () => {
      const incidentId = await createRawIncident();
      await openWarRoom(incidentId);

      const first = await joinWarRoom(incidentId, responder);
      expect(first.statusCode).toBe(200);
      expect(first.json().activeSessionCount).toBe(1);

      const second = await joinWarRoom(incidentId, responder);
      expect(second.statusCode).toBe(200);
      expect(second.json().activeSessionCount).toBe(1);

      const roomId = first.json().id as string;
      const sessions = await db
        .select()
        .from(warRoomSessions)
        .where(and(eq(warRoomSessions.warRoomId, roomId), eq(warRoomSessions.userId, responder.id)));
      expect(sessions).toHaveLength(1);
    });

    it("leaves, and repeated leave is a safe idempotent no-op", async () => {
      const incidentId = await createRawIncident();
      await openWarRoom(incidentId);
      await joinWarRoom(incidentId, responder);

      const first = await leaveWarRoom(incidentId, responder);
      expect(first.statusCode).toBe(200);
      expect(first.json().activeSessionCount).toBe(0);

      const second = await leaveWarRoom(incidentId, responder);
      expect(second.statusCode).toBe(200);
      expect(second.json().activeSessionCount).toBe(0);
    });

    it("persists session join/leave state and reflects it in the sessions list", async () => {
      const incidentId = await createRawIncident();
      await openWarRoom(incidentId);
      await joinWarRoom(incidentId, responder);
      await joinWarRoom(incidentId, incidentCommander);
      await leaveWarRoom(incidentId, responder);

      const response = await listSessions(incidentId);
      expect(response.statusCode).toBe(200);
      const items = response.json().items as Array<{ userId: string; status: string }>;
      expect(items.find((s) => s.userId === responder.id)?.status).toBe("left");
      expect(items.find((s) => s.userId === incidentCommander.id)?.status).toBe("joined");
    });

    it("rejects joining when the Incident is CLOSED even if the room row still shows open", async () => {
      const incidentId = await createRawIncident();
      await activateIncident(incidentId);
      await openWarRoom(incidentId);
      await closeIncident(incidentId);

      const response = await joinWarRoom(incidentId, responder);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("incident_closed");
    });

    it("still allows ending a stray open room after the Incident has closed (documented cleanup path)", async () => {
      const incidentId = await createRawIncident();
      await activateIncident(incidentId);
      await openWarRoom(incidentId);
      await closeIncident(incidentId);

      const response = await endWarRoom(incidentId);
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("ended");
    });
  });

  describe("CLOSED Incident open rejection", () => {
    it("rejects opening a War Room on a CLOSED Incident", async () => {
      const incidentId = await createRawIncident();
      await activateIncident(incidentId);
      await closeIncident(incidentId);

      const response = await openWarRoom(incidentId);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("incident_closed");
    });
  });

  describe("permission matrix", () => {
    it("AUDITOR can read but cannot open, join, or end", async () => {
      const incidentId = await createRawIncident();
      const readResponse = await getWarRoom(incidentId, auditor);
      expect(readResponse.statusCode).toBe(200);

      expect((await openWarRoom(incidentId, auditor)).statusCode).toBe(403);
      expect((await joinWarRoom(incidentId, auditor)).statusCode).toBe(403);

      await openWarRoom(incidentId, admin);
      expect((await endWarRoom(incidentId, auditor)).statusCode).toBe(403);
    });

    it("RESPONDER can read and join but cannot open or end", async () => {
      const incidentId = await createRawIncident();
      expect((await openWarRoom(incidentId, responder)).statusCode).toBe(403);

      await openWarRoom(incidentId, admin);
      expect((await joinWarRoom(incidentId, responder)).statusCode).toBe(200);
      expect((await endWarRoom(incidentId, responder)).statusCode).toBe(403);
    });

    it("requires authentication", async () => {
      const incidentId = await createRawIncident();
      const response = await app.inject({ method: "GET", url: `/incidents/${incidentId}/war-room` });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("timeline and audit", () => {
    it("appends exactly one WAR_ROOM_OPENED and one WAR_ROOM_ENDED timeline event, with no PII", async () => {
      const incidentId = await createRawIncident();
      await activateIncident(incidentId);
      await openWarRoom(incidentId);
      await joinWarRoom(incidentId, responder);
      await endWarRoom(incidentId);

      const timeline = await app.inject({ method: "GET", url: `/incidents/${incidentId}/timeline?order=asc`, ...authHeaders(admin) });
      const eventTypes = timeline.json().items.map((e: { eventType: string }) => e.eventType);
      expect(eventTypes.filter((t: string) => t === "WAR_ROOM_OPENED")).toHaveLength(1);
      expect(eventTypes.filter((t: string) => t === "WAR_ROOM_ENDED")).toHaveLength(1);

      const [responderRow] = await db.select({ email: users.email }).from(users).where(eq(users.id, responder.id));
      const serialized = JSON.stringify(timeline.json());
      expect(serialized).not.toContain(responderRow!.email);
    });

    it("does not write one timeline/audit event per join or leave", async () => {
      const incidentId = await createRawIncident();
      await openWarRoom(incidentId);
      await joinWarRoom(incidentId, responder);
      await leaveWarRoom(incidentId, responder);
      await joinWarRoom(incidentId, incidentCommander);
      await leaveWarRoom(incidentId, incidentCommander);

      const timeline = await app.inject({ method: "GET", url: `/incidents/${incidentId}/timeline`, ...authHeaders(admin) });
      const eventTypes = timeline.json().items.map((e: { eventType: string }) => e.eventType);
      expect(eventTypes).not.toContain("PARTICIPANT_JOINED_WAR_ROOM");
      expect(eventTypes.filter((t: string) => t === "WAR_ROOM_OPENED")).toHaveLength(1);
    });

    it("audits WAR_ROOM_OPENED/WAR_ROOM_ENDED without secrets or destination PII", async () => {
      const incidentId = await createRawIncident();
      await openWarRoom(incidentId);
      await endWarRoom(incidentId);

      const events = await db.select().from(auditLogs).where(eq(auditLogs.incidentId, incidentId));
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("WAR_ROOM_OPENED");
      expect(eventTypes).toContain("WAR_ROOM_ENDED");
      const serialized = JSON.stringify(events);
      expect(serialized).not.toMatch(/token|secret|password/i);
    });
  });
});
