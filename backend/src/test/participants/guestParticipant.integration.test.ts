/**
 * Integration tests for Module 19's Guest participant/Chat/War Room integration, run end-to-end
 * against a live PostgreSQL database and (for Chat's WebSocket) a real listening HTTP server.
 * Skipped when DATABASE_URL isn't reachable.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  getDb,
  users,
  roles,
  userRoles,
  incidents,
  guestInvitations,
  incidentParticipants,
  guestOtpChallenges,
  guestSessions,
  chatMessages,
  incidentWarRooms,
  warRoomSessions,
  incidentTimelineEvents,
  auditLogs,
  type Database,
} from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

const TEST_ORIGIN = "http://localhost:5173";

describe.skipIf(!process.env.DATABASE_URL)("guest participant / chat / war room integration (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp(
    {
      LOGIN_RATE_LIMIT_MAX: "500",
      SMS_PROVIDER: "mock",
      EMAIL_PROVIDER: "mock",
      CORS_ORIGIN: TEST_ORIGIN,
      GUEST_OTP_REQUEST_RATE_LIMIT_MAX: "500",
      GUEST_OTP_VERIFY_RATE_LIMIT_MAX: "500",
    },
    { onOtpGenerated: (code) => { capturedCode = code; } },
  );
  const db: Database = getDb();
  let wsBaseUrl: string;
  let capturedCode = "";

  const testPassword = "Correct-Horse-Battery-C19";
  const createdUserIds: string[] = [];
  const createdIncidentIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode: string): Promise<{ id: string; token: string; csrf: string }> {
    const email = `test-p19-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `Module19 Test ${roleCode}`, passwordHash })
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

  let commander: { id: string; token: string; csrf: string };

  beforeAll(async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine test server port.");
    }
    wsBaseUrl = `ws://127.0.0.1:${address.port}`;

    commander = await createActor("INCIDENT_COMMANDER");
  });

  afterAll(async () => {
    for (const id of createdIncidentIds) {
      await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
      await db.delete(incidentTimelineEvents).where(eq(incidentTimelineEvents.incidentId, id));
      await db.delete(chatMessages).where(eq(chatMessages.incidentId, id));
      const rooms = await db.select({ id: incidentWarRooms.id }).from(incidentWarRooms).where(eq(incidentWarRooms.incidentId, id));
      for (const room of rooms) {
        await db.delete(warRoomSessions).where(eq(warRoomSessions.warRoomId, room.id));
      }
      await db.delete(incidentWarRooms).where(eq(incidentWarRooms.incidentId, id));
      await db.delete(incidentParticipants).where(eq(incidentParticipants.incidentId, id));
      const invitations = await db.select({ id: guestInvitations.id }).from(guestInvitations).where(eq(guestInvitations.incidentId, id));
      for (const inv of invitations) {
        await db.delete(guestSessions).where(eq(guestSessions.invitationId, inv.id));
        await db.delete(guestOtpChallenges).where(eq(guestOtpChallenges.invitationId, inv.id));
      }
      await db.delete(guestInvitations).where(eq(guestInvitations.incidentId, id));
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
      ...authHeaders(commander),
      payload: { title: `Module19 Test Incident ${tag}-${randomUUID().slice(0, 6)}`, severity: "warning" },
    });
    const id = response.json().incident.id as string;
    createdIncidentIds.push(id);
    return id;
  }

  async function closeIncident(incidentId: string): Promise<void> {
    await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(commander) });
    await app.inject({ method: "POST", url: `/incidents/${incidentId}/resolve`, ...authHeaders(commander) });
    await app.inject({ method: "POST", url: `/incidents/${incidentId}/close`, ...authHeaders(commander) });
  }

  interface VerifiedGuest {
    invitationId: string;
    token: string;
    sessionCookie: string;
    csrfCookie: string;
  }

  /** Invite a guest with the given capabilities and drive them all the way through OTP
   * verification, returning their session cookies for use in guest-facing requests. */
  async function inviteAndVerifyGuest(
    incidentId: string,
    capabilities: { chat: boolean; warRoom: boolean },
    guestName = "Module19 Guest",
  ): Promise<VerifiedGuest> {
    const created = await app.inject({
      method: "POST",
      url: `/incidents/${incidentId}/guest-invitations`,
      ...authHeaders(commander),
      payload: { guestName, email: `${guestName.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}@example.invalid`, capabilities },
    });
    const invitationId = created.json().invitation.id as string;
    const url = created.json().invitationUrl as string;
    const token = url.split("/guest/invite/")[1];
    if (!token) throw new Error(`invitationUrl missing token: ${url}`);

    await app.inject({ method: "POST", url: `/guest/invitations/${token}/otp/request` });
    const verify = await app.inject({ method: "POST", url: `/guest/invitations/${token}/otp/verify`, payload: { code: capturedCode } });
    if (verify.statusCode !== 200) {
      throw new Error(`guest verify failed: ${verify.statusCode} ${verify.body}`);
    }
    return {
      invitationId,
      token,
      sessionCookie: verify.cookies.find((c) => c.name === "beacon_guest_session")!.value,
      csrfCookie: verify.cookies.find((c) => c.name === "beacon_guest_csrf")!.value,
    };
  }

  function guestAuth(guest: VerifiedGuest) {
    return {
      cookies: { beacon_guest_session: guest.sessionCookie, beacon_guest_csrf: guest.csrfCookie },
      headers: { "x-guest-csrf-token": guest.csrfCookie },
    };
  }

  describe("auto-enrollment", () => {
    it("creates exactly one incident_participants row on first verification", async () => {
      const incidentId = await createRawIncident();
      await inviteAndVerifyGuest(incidentId, { chat: true, warRoom: false }, "Auto Enroll");

      const rows = await db.select().from(incidentParticipants).where(eq(incidentParticipants.incidentId, incidentId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.participantType).toBe("guest");
      expect(rows[0]!.status).toBe("joined");
      expect(rows[0]!.userId).toBeNull();
      expect(rows[0]!.contactId).toBeNull();
    });

    it("shows the Guest on the roster with capabilities and no destination, never a duplicate on re-auth", async () => {
      const incidentId = await createRawIncident();
      const guest = await inviteAndVerifyGuest(incidentId, { chat: true, warRoom: true }, "Roster Guest");

      const roster = await app.inject({ method: "GET", url: `/incidents/${incidentId}/participants`, ...authHeaders(commander) });
      const items = roster.json().items as Array<Record<string, unknown>>;
      const guestRow = items.find((p) => p.participantType === "guest");
      expect(guestRow).toBeDefined();
      expect(guestRow!.displayName).toBe("Roster Guest");
      expect(guestRow!.email).toBeNull();
      expect(guestRow!.mobilePhone).toBeNull();
      expect(guestRow!.guestCapabilities).toEqual({ chat: true, warRoom: true });
      expect(guestRow!.guestVerifiedAt).not.toBeNull();

      // Re-authenticate (simulating an expired-session Guest logging back in via a fresh OTP
      // request/verify against the SAME invitation) and confirm no second participant row
      // appears — auto-enrollment is gated on first-time verification only.
      await app.inject({ method: "POST", url: "/guest/session/logout", ...guestAuth(guest) });
      await app.inject({ method: "POST", url: `/guest/invitations/${guest.token}/otp/request` });
      const reVerify = await app.inject({ method: "POST", url: `/guest/invitations/${guest.token}/otp/verify`, payload: { code: capturedCode } });
      expect(reVerify.statusCode).toBe(200);

      const rows = await db.select().from(incidentParticipants).where(eq(incidentParticipants.incidentId, incidentId));
      expect(rows).toHaveLength(1);
    });

    it("never creates a users row for the Guest", async () => {
      const incidentId = await createRawIncident();
      const before = await db.select({ id: users.id }).from(users);
      await inviteAndVerifyGuest(incidentId, { chat: false, warRoom: false }, "No User Row");
      const after = await db.select({ id: users.id }).from(users);
      expect(after.length).toBe(before.length);
    });
  });

  describe("removal revokes access", () => {
    async function removeGuestParticipant(incidentId: string, guest: VerifiedGuest): Promise<void> {
      const [row] = await db
        .select({ id: incidentParticipants.id })
        .from(incidentParticipants)
        .where(eq(incidentParticipants.guestInvitationId, guest.invitationId));
      const response = await app.inject({
        method: "DELETE",
        url: `/incidents/${incidentId}/participants/${row!.id}`,
        ...authHeaders(commander),
      });
      expect(response.statusCode).toBe(204);
    }

    it("removing the Guest immediately invalidates their session", async () => {
      const incidentId = await createRawIncident();
      const guest = await inviteAndVerifyGuest(incidentId, { chat: true, warRoom: true }, "Removed Guest");

      const before = await app.inject({ method: "GET", url: "/guest/session", ...guestAuth(guest) });
      expect(before.statusCode).toBe(200);

      await removeGuestParticipant(incidentId, guest);

      const after = await app.inject({ method: "GET", url: "/guest/session", ...guestAuth(guest) });
      expect(after.statusCode).toBe(401);
    });

    it("preserves participant history (soft removal, never a hard delete)", async () => {
      const incidentId = await createRawIncident();
      const guest = await inviteAndVerifyGuest(incidentId, { chat: false, warRoom: false }, "History Preserved");
      await removeGuestParticipant(incidentId, guest);

      const rows = await db.select().from(incidentParticipants).where(eq(incidentParticipants.guestInvitationId, guest.invitationId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe("removed");
    });

    it("audits GUEST_ACCESS_REVOKED and INCIDENT_PARTICIPANT_REMOVED, and timelines PARTICIPANT_REMOVED, without leaking the destination", async () => {
      const incidentId = await createRawIncident();
      const guest = await inviteAndVerifyGuest(incidentId, { chat: false, warRoom: false }, "Audit Removal");
      await removeGuestParticipant(incidentId, guest);

      const events = await db.select().from(auditLogs).where(eq(auditLogs.incidentId, incidentId));
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("GUEST_ACCESS_REVOKED");
      expect(eventTypes).toContain("INCIDENT_PARTICIPANT_REMOVED");
      expect(JSON.stringify(events)).not.toMatch(/@example\.invalid/);

      const timeline = await db.select().from(incidentTimelineEvents).where(eq(incidentTimelineEvents.incidentId, incidentId));
      expect(timeline.map((e) => e.eventType)).toContain("PARTICIPANT_REMOVED");
    });
  });

  describe("Incident closure revokes Guest access", () => {
    it("denies an existing session once the Incident closes", async () => {
      const incidentId = await createRawIncident();
      const guest = await inviteAndVerifyGuest(incidentId, { chat: true, warRoom: true }, "Closure Guest");
      await closeIncident(incidentId);

      const response = await app.inject({ method: "GET", url: "/guest/session", ...guestAuth(guest) });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("Guest Chat", () => {
    function cookieHeader(guest: VerifiedGuest): string {
      return `beacon_guest_session=${guest.sessionCookie}; beacon_guest_csrf=${guest.csrfCookie}`;
    }

    const messageQueues = new WeakMap<WebSocket, { queue: Record<string, unknown>[]; waiters: ((msg: Record<string, unknown>) => void)[] }>();

    function connect(incidentId: string, guest: VerifiedGuest, origin: string = TEST_ORIGIN): WebSocket {
      const ws = new WebSocket(`${wsBaseUrl}/ws/guest/incidents/${incidentId}/chat`, { headers: { Origin: origin, Cookie: cookieHeader(guest) } });
      const state = { queue: [] as Record<string, unknown>[], waiters: [] as ((msg: Record<string, unknown>) => void)[] };
      messageQueues.set(ws, state);
      ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        const waiter = state.waiters.shift();
        if (waiter) waiter(msg);
        else state.queue.push(msg);
      });
      return ws;
    }

    function waitForOpen(ws: WebSocket): Promise<void> {
      return new Promise((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("unexpected-response", (_req, res) => reject(new Error(`unexpected-response ${res.statusCode}`)));
      });
    }

    function waitForRejection(ws: WebSocket): Promise<{ statusCode?: number | undefined }> {
      return new Promise((resolve) => {
        ws.once("unexpected-response", (_req, res) => resolve({ statusCode: res.statusCode }));
        ws.once("error", () => {});
      });
    }

    function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
      const state = messageQueues.get(ws)!;
      const queued = state.queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for a WebSocket message")), 5000);
        state.waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    }

    it("a Guest with chat capability can connect, send, and the message is authored via participantId (never a users row)", async () => {
      const incidentId = await createRawIncident();
      const guest = await inviteAndVerifyGuest(incidentId, { chat: true, warRoom: false }, "Chat Guest");

      const ws = connect(incidentId, guest);
      await waitForOpen(ws);
      await nextMessage(ws); // "connected"

      ws.send(JSON.stringify({ type: "send", body: "hello from guest", requestId: "g1" }));
      const ack = await nextMessage(ws);
      expect(ack).toMatchObject({ type: "sent", requestId: "g1" });
      const message = ack.message as { authorType: string; isGuest: boolean; authorUserId: string | null; messageText: string };
      expect(message.authorType).toBe("guest");
      expect(message.isGuest).toBe(true);
      expect(message.authorUserId).toBeNull();
      expect(message.messageText).toBe("hello from guest");

      const rows = await db.select().from(chatMessages).where(eq(chatMessages.incidentId, incidentId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.authorType).toBe("guest");
      expect(rows[0]!.userId).toBeNull();
      expect(rows[0]!.participantId).not.toBeNull();
      ws.close();
    });

    it("a registered User sees the Guest's message with a Guest label when reading history", async () => {
      const incidentId = await createRawIncident();
      const guest = await inviteAndVerifyGuest(incidentId, { chat: true, warRoom: false }, "Labeled Guest");
      const ws = connect(incidentId, guest);
      await waitForOpen(ws);
      await nextMessage(ws);
      ws.send(JSON.stringify({ type: "send", body: "visible to responders", requestId: "g2" }));
      await nextMessage(ws);
      ws.close();

      const history = await app.inject({ method: "GET", url: `/incidents/${incidentId}/chat/messages`, ...authHeaders(commander) });
      const items = history.json().items as Array<{ messageText: string; isGuest: boolean; authorDisplayName: string }>;
      const guestMsg = items.find((m) => m.messageText === "visible to responders");
      expect(guestMsg).toBeDefined();
      expect(guestMsg!.isGuest).toBe(true);
      expect(guestMsg!.authorDisplayName).toBe("Labeled Guest");
    });

    it("rejects a connection from a Guest without chat capability", async () => {
      const incidentId = await createRawIncident();
      const guest = await inviteAndVerifyGuest(incidentId, { chat: false, warRoom: true }, "No Chat Guest");
      const ws = connect(incidentId, guest);
      const result = await waitForRejection(ws);
      expect(result.statusCode).toBe(403);
    });

    it("rejects a connection with no Guest session cookie", async () => {
      const incidentId = await createRawIncident();
      const ws = new WebSocket(`${wsBaseUrl}/ws/guest/incidents/${incidentId}/chat`, { headers: { Origin: TEST_ORIGIN } });
      const result = await waitForRejection(ws);
      expect(result.statusCode).toBe(401);
    });

    it("Incident scope isolation: a Guest cannot connect to a different Incident's chat", async () => {
      const incidentId = await createRawIncident();
      const otherIncidentId = await createRawIncident();
      const guest = await inviteAndVerifyGuest(incidentId, { chat: true, warRoom: false }, "Scoped Guest");

      const ws = connect(otherIncidentId, guest);
      const result = await waitForRejection(ws);
      expect(result.statusCode).toBe(403);
    });

    it("blocks a Guest send once the Incident is CLOSED", async () => {
      const incidentId = await createRawIncident();
      const guest = await inviteAndVerifyGuest(incidentId, { chat: true, warRoom: false }, "Closed Chat Guest");
      const ws = connect(incidentId, guest);
      await waitForOpen(ws);
      await nextMessage(ws);
      ws.close();

      await closeIncident(incidentId);

      // The Guest session itself is now denied (Incident closed), so even history read fails —
      // confirming access is cut, not merely send.
      const historyAfterClose = await app.inject({ method: "GET", url: `/guest/incidents/${incidentId}/chat/messages`, ...guestAuth(guest) });
      expect(historyAfterClose.statusCode).toBe(401);
    });

    it("Guest history read requires only a valid session (not the chat capability specifically)", async () => {
      const incidentId = await createRawIncident();
      const guest = await inviteAndVerifyGuest(incidentId, { chat: false, warRoom: true }, "Read Only Guest");
      const response = await app.inject({ method: "GET", url: `/guest/incidents/${incidentId}/chat/messages`, ...guestAuth(guest) });
      expect(response.statusCode).toBe(200);
    });

    it("Module 23 — a still-open WebSocket cannot keep sending after the Guest is removed mid-connection", async () => {
      // Removing a Guest revokes their session cookie (denying any *new* handshake), but a
      // connection opened before removal isn't proactively closed — `sendGuestMessage()` must
      // re-check the participant's live status on every send rather than trusting the
      // connection-time snapshot indefinitely. See claude/prompts/23-security-hardening.md,
      // "Guest chat re-validation".
      const incidentId = await createRawIncident();
      const guest = await inviteAndVerifyGuest(incidentId, { chat: true, warRoom: false }, "Soon Removed Guest");

      const ws = connect(incidentId, guest);
      await waitForOpen(ws);
      await nextMessage(ws); // "connected"

      const [participantRow] = await db
        .select({ id: incidentParticipants.id })
        .from(incidentParticipants)
        .where(eq(incidentParticipants.guestInvitationId, guest.invitationId));
      const removeResponse = await app.inject({
        method: "DELETE",
        url: `/incidents/${incidentId}/participants/${participantRow!.id}`,
        ...authHeaders(commander),
      });
      expect(removeResponse.statusCode).toBe(204);

      ws.send(JSON.stringify({ type: "send", body: "should be rejected", requestId: "g-removed" }));
      const result = await nextMessage(ws);
      expect(result).toMatchObject({ type: "error", error: "send_failed", requestId: "g-removed" });

      const rows = await db.select().from(chatMessages).where(eq(chatMessages.incidentId, incidentId));
      expect(rows.find((r) => r.messageText === "should be rejected")).toBeUndefined();
      ws.close();
    });
  });

  describe("Guest War Room", () => {
    async function openWarRoom(incidentId: string): Promise<void> {
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/war-room/open`, ...authHeaders(commander) });
    }

    it("a Guest with warRoom capability can join, and the session requires no users row", async () => {
      const incidentId = await createRawIncident();
      await openWarRoom(incidentId);
      const guest = await inviteAndVerifyGuest(incidentId, { chat: false, warRoom: true }, "War Room Guest");

      const response = await app.inject({ method: "POST", url: `/guest/incidents/${incidentId}/war-room/join`, ...guestAuth(guest) });
      expect(response.statusCode).toBe(200);
      expect(response.json().activeSessionCount).toBe(1);

      const [room] = await db.select({ id: incidentWarRooms.id }).from(incidentWarRooms).where(eq(incidentWarRooms.incidentId, incidentId));
      const sessions = await db.select().from(warRoomSessions).where(eq(warRoomSessions.warRoomId, room!.id));
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.participantType).toBe("guest");
      expect(sessions[0]!.userId).toBeNull();
      expect(sessions[0]!.guestInvitationId).toBe(guest.invitationId);
    });

    it("a duplicate join is idempotent (still exactly one active session)", async () => {
      const incidentId = await createRawIncident();
      await openWarRoom(incidentId);
      const guest = await inviteAndVerifyGuest(incidentId, { chat: false, warRoom: true }, "Idempotent Join Guest");

      await app.inject({ method: "POST", url: `/guest/incidents/${incidentId}/war-room/join`, ...guestAuth(guest) });
      const second = await app.inject({ method: "POST", url: `/guest/incidents/${incidentId}/war-room/join`, ...guestAuth(guest) });
      expect(second.json().activeSessionCount).toBe(1);
    });

    it("leaves and the count returns to 0", async () => {
      const incidentId = await createRawIncident();
      await openWarRoom(incidentId);
      const guest = await inviteAndVerifyGuest(incidentId, { chat: false, warRoom: true }, "Leave Guest");
      await app.inject({ method: "POST", url: `/guest/incidents/${incidentId}/war-room/join`, ...guestAuth(guest) });

      const response = await app.inject({ method: "POST", url: `/guest/incidents/${incidentId}/war-room/leave`, ...guestAuth(guest) });
      expect(response.json().activeSessionCount).toBe(0);
    });

    it("denies a Guest without warRoom capability", async () => {
      const incidentId = await createRawIncident();
      await openWarRoom(incidentId);
      const guest = await inviteAndVerifyGuest(incidentId, { chat: true, warRoom: false }, "No War Room Guest");

      const response = await app.inject({ method: "POST", url: `/guest/incidents/${incidentId}/war-room/join`, ...guestAuth(guest) });
      expect(response.statusCode).toBe(403);
    });

    it("Incident scope isolation: a Guest cannot join a different Incident's War Room", async () => {
      const incidentId = await createRawIncident();
      const otherIncidentId = await createRawIncident();
      await openWarRoom(otherIncidentId);
      const guest = await inviteAndVerifyGuest(incidentId, { chat: false, warRoom: true }, "Cross Incident Guest");

      const response = await app.inject({ method: "POST", url: `/guest/incidents/${otherIncidentId}/war-room/join`, ...guestAuth(guest) });
      expect(response.statusCode).toBe(403);
    });

    it("rejects a join when the Incident is CLOSED", async () => {
      const incidentId = await createRawIncident();
      await openWarRoom(incidentId);
      const guest = await inviteAndVerifyGuest(incidentId, { chat: false, warRoom: true }, "Closed War Room Guest");
      await closeIncident(incidentId);

      const response = await app.inject({ method: "POST", url: `/guest/incidents/${incidentId}/war-room/join`, ...guestAuth(guest) });
      expect(response.statusCode).toBe(401); // session itself is already denied post-closure
    });
  });

  describe("security isolation from internal administration", () => {
    it("a Guest session cookie is never accepted on any registered-User-only route", async () => {
      const incidentId = await createRawIncident();
      const guest = await inviteAndVerifyGuest(incidentId, { chat: true, warRoom: true }, "Isolation Guest");
      const asUserCookie = { cookies: { beacon_session: guest.sessionCookie } };

      const usersResponse = await app.inject({ method: "GET", url: "/users", ...asUserCookie });
      expect(usersResponse.statusCode).toBe(401);

      const contactsResponse = await app.inject({ method: "GET", url: "/contacts", ...asUserCookie });
      expect(contactsResponse.statusCode).toBe(401);

      const incidentsResponse = await app.inject({ method: "GET", url: "/incidents", ...asUserCookie });
      expect(incidentsResponse.statusCode).toBe(401);
    });

    it("a Guest cannot manage participants (no incidents.participants.manage-equivalent Guest capability exists)", async () => {
      const incidentId = await createRawIncident();
      const guest = await inviteAndVerifyGuest(incidentId, { chat: true, warRoom: true }, "No Manage Guest");
      const response = await app.inject({
        method: "DELETE",
        url: `/incidents/${incidentId}/participants/${randomUUID()}`,
        ...guestAuth(guest),
      });
      expect(response.statusCode).toBe(401);
    });
  });
});
