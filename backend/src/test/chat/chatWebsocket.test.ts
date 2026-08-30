/**
 * Integration tests for Module 13's realtime incident chat, run end-to-end against a live
 * PostgreSQL database and a real listening HTTP server (a WebSocket upgrade cannot be exercised
 * through Fastify's `inject()` — it needs an actual TCP socket). Skipped when DATABASE_URL isn't
 * reachable. Runs sequentially with other backend test files (`fileParallelism: false`).
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { getDb, users, roles, userRoles, incidents, chatMessages, auditLogs, type Database } from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

const TEST_ORIGIN = "http://localhost:5173";

describe.skipIf(!process.env.DATABASE_URL)("incident chat WebSocket (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500", CORS_ORIGIN: TEST_ORIGIN });
  const db: Database = getDb();
  let wsBaseUrl: string;

  const testPassword = "Correct-Horse-Battery-C13";
  const createdUserIds: string[] = [];
  const createdIncidentIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode?: string): Promise<{ id: string; token: string; csrf: string }> {
    const label = roleCode ?? "noperm";
    const email = `test-chat-${label.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `Chat Test ${label}`, passwordHash })
      .returning({ id: users.id });
    createdUserIds.push(row!.id);
    if (roleCode) {
      await db.insert(userRoles).values({ userId: row!.id, roleId: await roleId(roleCode) });
    }

    const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: testPassword } });
    if (response.statusCode !== 200) {
      throw new Error(`login failed for ${label}: ${response.statusCode} ${response.body}`);
    }
    return {
      id: row!.id,
      token: response.cookies.find((c) => c.name === config.sessionCookieName)!.value,
      csrf: response.cookies.find((c) => c.name === config.csrfCookieName)!.value,
    };
  }

  function cookieHeader(actor: { token: string; csrf: string }): string {
    return `${config.sessionCookieName}=${actor.token}; ${config.csrfCookieName}=${actor.csrf}`;
  }

  let admin: { id: string; token: string; csrf: string };
  let auditor: { id: string; token: string; csrf: string };
  let noPerm: { id: string; token: string; csrf: string };

  async function createRawIncident(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/incidents",
      cookies: { [config.sessionCookieName]: admin.token, [config.csrfCookieName]: admin.csrf },
      headers: { "x-csrf-token": admin.csrf },
      payload: { title: `Chat Test Incident ${tag}-${randomUUID().slice(0, 6)}`, severity: "warning" },
    });
    const id = response.json().incident.id as string;
    createdIncidentIds.push(id);
    return id;
  }

  beforeAll(async () => {
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to determine test server port.");
    }
    wsBaseUrl = `ws://127.0.0.1:${address.port}`;

    admin = await createActor("ADMIN");
    auditor = await createActor("AUDITOR");
    noPerm = await createActor();
  });

  afterAll(async () => {
    for (const id of createdIncidentIds) {
      await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
      await db.delete(chatMessages).where(eq(chatMessages.incidentId, id));
      await db.delete(incidents).where(eq(incidents.id, id));
    }
    for (const id of createdUserIds) {
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
      await db.delete(users).where(eq(users.id, id));
    }
    await app.close();
  });

  /**
   * Buffers every incoming message from the moment a socket is created — a one-shot
   * `ws.once("message", ...)` attached only when the test later calls `nextMessage()` can race
   * against messages the server sends immediately after upgrade (e.g. "connected"), since Node's
   * EventEmitter never buffers an event for a listener that wasn't attached yet.
   */
  const messageQueues = new WeakMap<WebSocket, { queue: Record<string, unknown>[]; waiters: ((msg: Record<string, unknown>) => void)[] }>();

  function connect(
    incidentId: string,
    actor: { token: string; csrf: string } | null,
    origin: string = TEST_ORIGIN,
  ): WebSocket {
    const headers: Record<string, string> = { Origin: origin };
    if (actor) headers.Cookie = cookieHeader(actor);
    const ws = new WebSocket(`${wsBaseUrl}/ws/incidents/${incidentId}/chat`, { headers });
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
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => reject(new Error(`unexpected-response ${res.statusCode}`)));
    });
  }

  function waitForRejection(ws: WebSocket): Promise<{ statusCode?: number | undefined; closeCode?: number | undefined }> {
    return new Promise((resolve) => {
      ws.once("unexpected-response", (_req, res) => resolve({ statusCode: res.statusCode }));
      ws.once("close", (code) => resolve({ closeCode: code }));
      ws.once("error", () => {
        /* some rejections surface as a plain error before unexpected-response/close on some platforms */
      });
    });
  }

  function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
    const state = messageQueues.get(ws);
    if (!state) throw new Error("nextMessage() called on a socket not created via connect()");

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

  function sendFrame(ws: WebSocket, frame: Record<string, unknown>): void {
    ws.send(JSON.stringify(frame));
  }

  describe("WebSocket authentication and authorization", () => {
    it("rejects a connection with no session cookie", async () => {
      const incidentId = await createRawIncident();
      const ws = connect(incidentId, null);
      const result = await waitForRejection(ws);
      expect(result.statusCode).toBe(401);
    });

    it("rejects a connection from an unexpected Origin", async () => {
      const incidentId = await createRawIncident();
      const ws = connect(incidentId, admin, "https://evil.example");
      const result = await waitForRejection(ws);
      expect(result.statusCode).toBe(403);
    });

    it("rejects a user without incidents.chat.read", async () => {
      const incidentId = await createRawIncident();
      const ws = connect(incidentId, noPerm);
      const result = await waitForRejection(ws);
      expect(result.statusCode).toBe(403);
    });

    it("rejects a connection to a nonexistent Incident after upgrade, with a safe close code", async () => {
      const ws = connect(randomUUID(), admin);
      await waitForOpen(ws);
      const closeInfo = await new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
      expect(closeInfo).toBe(4404);
    });

    it("accepts a connection for a user with incidents.chat.read (AUDITOR, read-only)", async () => {
      const incidentId = await createRawIncident();
      const ws = connect(incidentId, auditor);
      await waitForOpen(ws);
      const connectedMsg = await nextMessage(ws);
      expect(connectedMsg).toMatchObject({ type: "connected", incidentId });
      ws.close();
    });
  });

  describe("send authorization", () => {
    it("rejects a send from AUDITOR (read-only) without persisting anything", async () => {
      const incidentId = await createRawIncident();
      const ws = connect(incidentId, auditor);
      await waitForOpen(ws);
      await nextMessage(ws); // "connected"

      sendFrame(ws, { type: "send", body: "hello", requestId: "r1" });
      const response = await nextMessage(ws);
      expect(response).toMatchObject({ type: "error", error: "not_authorized", requestId: "r1" });

      const rows = await db.select().from(chatMessages).where(eq(chatMessages.incidentId, incidentId));
      expect(rows).toHaveLength(0);
      ws.close();
    });

    it("allows a send from ADMIN (read+send) and persists it", async () => {
      const incidentId = await createRawIncident();
      const ws = connect(incidentId, admin);
      await waitForOpen(ws);
      await nextMessage(ws); // "connected"

      sendFrame(ws, { type: "send", body: "hello team", requestId: "r2" });
      const ack = await nextMessage(ws);
      expect(ack).toMatchObject({ type: "sent", requestId: "r2" });

      const rows = await db.select().from(chatMessages).where(eq(chatMessages.incidentId, incidentId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.messageText).toBe("hello team");
      expect(rows[0]!.authorType).toBe("user");
      expect(rows[0]!.userId).toBe(admin.id);
      ws.close();
    });
  });

  describe("broadcast and persistence ordering", () => {
    it("broadcasts a persisted message to another connected client on the same Incident", async () => {
      const incidentId = await createRawIncident();
      const wsA = connect(incidentId, admin);
      const wsB = connect(incidentId, auditor);
      await Promise.all([waitForOpen(wsA), waitForOpen(wsB)]);
      await Promise.all([nextMessage(wsA), nextMessage(wsB)]); // "connected" for both

      const bReceived = nextMessage(wsB);
      sendFrame(wsA, { type: "send", body: "visible to B too", requestId: "r3" });
      await nextMessage(wsA); // ack to A

      const broadcastToB = await bReceived;
      expect(broadcastToB).toMatchObject({ type: "message" });
      const message = broadcastToB.message as { messageText: string; authorUserId: string };
      expect(message.messageText).toBe("visible to B too");
      expect(message.authorUserId).toBe(admin.id);

      wsA.close();
      wsB.close();
    });

    it("does not broadcast anything if persistence fails (message on a CLOSED Incident)", async () => {
      const incidentId = await createRawIncident();
      await app.inject({
        method: "POST",
        url: `/incidents/${incidentId}/activate`,
        cookies: { [config.sessionCookieName]: admin.token, [config.csrfCookieName]: admin.csrf },
        headers: { "x-csrf-token": admin.csrf },
      });
      await app.inject({
        method: "POST",
        url: `/incidents/${incidentId}/resolve`,
        cookies: { [config.sessionCookieName]: admin.token, [config.csrfCookieName]: admin.csrf },
        headers: { "x-csrf-token": admin.csrf },
      });
      await app.inject({
        method: "POST",
        url: `/incidents/${incidentId}/close`,
        cookies: { [config.sessionCookieName]: admin.token, [config.csrfCookieName]: admin.csrf },
        headers: { "x-csrf-token": admin.csrf },
      });

      const wsA = connect(incidentId, admin);
      const wsB = connect(incidentId, auditor);
      await Promise.all([waitForOpen(wsA), waitForOpen(wsB)]);
      await Promise.all([nextMessage(wsA), nextMessage(wsB)]);

      sendFrame(wsA, { type: "send", body: "should be rejected", requestId: "r4" });
      const response = await nextMessage(wsA);
      expect(response).toMatchObject({ type: "error", error: "send_failed", requestId: "r4" });
      expect((response.message as string)).toMatch(/closed/i);

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(messageQueues.get(wsB)!.queue).toHaveLength(0);

      const rows = await db.select().from(chatMessages).where(eq(chatMessages.incidentId, incidentId));
      expect(rows).toHaveLength(0);

      wsA.close();
      wsB.close();
    });
  });

  describe("payload validation", () => {
    it("rejects an empty/whitespace-only message", async () => {
      const incidentId = await createRawIncident();
      const ws = connect(incidentId, admin);
      await waitForOpen(ws);
      await nextMessage(ws);

      sendFrame(ws, { type: "send", body: "   ", requestId: "r5" });
      const response = await nextMessage(ws);
      expect(response.type).toBe("error");
      expect(response.error).toBe("send_failed");
      ws.close();
    });

    it("rejects a message over the maximum length", async () => {
      const incidentId = await createRawIncident();
      const ws = connect(incidentId, admin);
      await waitForOpen(ws);
      await nextMessage(ws);

      sendFrame(ws, { type: "send", body: "x".repeat(4001), requestId: "r6" });
      const response = await nextMessage(ws);
      expect(response.type).toBe("error");
      expect(response.error).toBe("send_failed");

      const rows = await db.select().from(chatMessages).where(eq(chatMessages.incidentId, incidentId));
      expect(rows).toHaveLength(0);
      ws.close();
    });

    it("rejects an unknown command type", async () => {
      const incidentId = await createRawIncident();
      const ws = connect(incidentId, admin);
      await waitForOpen(ws);
      await nextMessage(ws);

      sendFrame(ws, { type: "delete_everything" });
      const response = await nextMessage(ws);
      expect(response).toMatchObject({ type: "error", error: "unknown_command" });
      ws.close();
    });

    it("rejects malformed JSON", async () => {
      const incidentId = await createRawIncident();
      const ws = connect(incidentId, admin);
      await waitForOpen(ws);
      await nextMessage(ws);

      ws.send("{not json");
      const response = await nextMessage(ws);
      expect(response).toMatchObject({ type: "error", error: "invalid_payload" });
      ws.close();
    });

    it("stores an XSS-shaped body as inert plain text, unmodified", async () => {
      const incidentId = await createRawIncident();
      const ws = connect(incidentId, admin);
      await waitForOpen(ws);
      await nextMessage(ws);

      const payload = "<script>alert(1)</script>";
      sendFrame(ws, { type: "send", body: payload, requestId: "r7" });
      const ack = await nextMessage(ws);
      const message = ack.message as { messageText: string };
      expect(message.messageText).toBe(payload); // stored verbatim — never HTML-escaped/stripped

      const rows = await db.select().from(chatMessages).where(eq(chatMessages.incidentId, incidentId));
      expect(rows[0]!.messageText).toBe(payload);
      ws.close();
    });
  });

  describe("rate limiting", () => {
    it("rate-limits a burst of sends without closing the connection", async () => {
      const incidentId = await createRawIncident();
      const ws = connect(incidentId, admin);
      await waitForOpen(ws);
      await nextMessage(ws);

      const outcomes: string[] = [];
      for (let i = 0; i < 18; i += 1) {
        sendFrame(ws, { type: "send", body: `burst ${i}`, requestId: `burst-${i}` });
        const response = await nextMessage(ws);
        outcomes.push(response.type as string);
      }
      expect(outcomes.filter((t) => t === "error")).not.toHaveLength(0);
      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });
  });

  describe("REST message history", () => {
    it("returns messages in ascending order with cursor-based pagination", async () => {
      const incidentId = await createRawIncident();
      const ws = connect(incidentId, admin);
      await waitForOpen(ws);
      await nextMessage(ws);

      for (let i = 0; i < 5; i += 1) {
        sendFrame(ws, { type: "send", body: `msg ${i}`, requestId: `h-${i}` });
        await nextMessage(ws);
      }
      ws.close();

      const firstPage = await app.inject({
        method: "GET",
        url: `/incidents/${incidentId}/chat/messages?limit=3`,
        cookies: { [config.sessionCookieName]: admin.token, [config.csrfCookieName]: admin.csrf },
      });
      expect(firstPage.statusCode).toBe(200);
      const firstBody = firstPage.json();
      expect(firstBody.items.map((m: { messageText: string }) => m.messageText)).toEqual(["msg 2", "msg 3", "msg 4"]);
      expect(firstBody.hasMore).toBe(true);

      const cursor = firstBody.items[0].seq as number;
      const secondPage = await app.inject({
        method: "GET",
        url: `/incidents/${incidentId}/chat/messages?limit=3&before=${cursor}`,
        cookies: { [config.sessionCookieName]: admin.token, [config.csrfCookieName]: admin.csrf },
      });
      const secondBody = secondPage.json();
      expect(secondBody.items.map((m: { messageText: string }) => m.messageText)).toEqual(["msg 0", "msg 1"]);
      expect(secondBody.hasMore).toBe(false);
    });

    it("requires incidents.chat.read to view history", async () => {
      const incidentId = await createRawIncident();
      const response = await app.inject({
        method: "GET",
        url: `/incidents/${incidentId}/chat/messages`,
        cookies: { [config.sessionCookieName]: noPerm.token, [config.csrfCookieName]: noPerm.csrf },
      });
      expect(response.statusCode).toBe(403);
    });

    it("history remains readable on a CLOSED Incident even though sending is blocked", async () => {
      const incidentId = await createRawIncident();
      const ws = connect(incidentId, admin);
      await waitForOpen(ws);
      await nextMessage(ws);
      sendFrame(ws, { type: "send", body: "before close", requestId: "r8" });
      await nextMessage(ws);
      ws.close();

      const auth = { cookies: { [config.sessionCookieName]: admin.token, [config.csrfCookieName]: admin.csrf }, headers: { "x-csrf-token": admin.csrf } };
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...auth });
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/resolve`, ...auth });
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/close`, ...auth });

      const history = await app.inject({
        method: "GET",
        url: `/incidents/${incidentId}/chat/messages`,
        cookies: { [config.sessionCookieName]: admin.token, [config.csrfCookieName]: admin.csrf },
      });
      expect(history.statusCode).toBe(200);
      expect(history.json().items.map((m: { messageText: string }) => m.messageText)).toContain("before close");
    });
  });
});
