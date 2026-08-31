/**
 * Module 24 — lightweight local Chat WebSocket load harness. Establishes an observed local
 * baseline, not a production capacity guarantee. Never runs as part of the normal test suite.
 *
 *   npx tsx scripts/load/chat-load.ts
 *
 * Requires DATABASE_URL to be reachable. Creates and cleans up its own synthetic Admin user and
 * one Incident; never touches real data.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import WebSocket from "ws";
import { getDb, users, roles, userRoles, incidents, chatMessages, auditLogs, closeDb } from "@beacon/database";
import { buildApp } from "../../backend/src/app.js";
import { loadEnv } from "../../backend/src/config/env.js";

loadDotenv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });

const CLIENT_COUNT = 15;
const MESSAGES_PER_CLIENT = 5;
const PER_CLIENT_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — cannot run the load harness against a real database.");
    process.exit(1);
  }

  const env = loadEnv({ CORS_ORIGIN: "http://localhost:5173" });
  const app = buildApp({ env });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("failed to determine listening port");
  const httpBaseUrl = `http://127.0.0.1:${address.port}`;
  const wsBaseUrl = `ws://127.0.0.1:${address.port}`;

  const db = getDb();
  const { hashPassword } = await import("../../backend/src/modules/auth/password.js");
  const { loadAuthConfig } = await import("../../backend/src/modules/auth/config.js");
  const authConfig = loadAuthConfig();

  let adminUserId: string | undefined;
  let incidentIdForCleanup: string | undefined;

  try {
  const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, "ADMIN")).limit(1);
  const email = `test-c24-chatload-admin-${randomUUID()}@example.invalid`;
  const passwordHash = await hashPassword("Correct-Horse-Battery-C24-ChatLoad", authConfig);
  const [adminUser] = await db.insert(users).values({ email, displayName: "Chat Load Admin", passwordHash }).returning({ id: users.id });
  adminUserId = adminUser!.id;
  await db.insert(userRoles).values({ userId: adminUser!.id, roleId: adminRole!.id });

  const loginRes = await fetch(`${httpBaseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Correct-Horse-Battery-C24-ChatLoad" }),
  });
  const setCookieHeaders = loginRes.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookieHeaders.map((c) => c.split(";")[0]).join("; ");
  const csrfCookie = setCookieHeaders.find((c) => c.startsWith(`${authConfig.csrfCookieName}=`));
  const csrfToken = csrfCookie ? csrfCookie.split(";")[0]!.split("=")[1]! : "";

  const created = await fetch(`${httpBaseUrl}/incidents`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: sessionCookie, "x-csrf-token": csrfToken },
    body: JSON.stringify({ title: "Chat Load Test Incident", severity: "warning" }),
  });
  const incidentBody = (await created.json()) as { incident: { id: string } };
  const incidentId = incidentBody.incident.id;
  incidentIdForCleanup = incidentId;

  console.log(`Chat load harness — ${CLIENT_COUNT} clients × ${MESSAGES_PER_CLIENT} messages each\n`);

  const start = performance.now();
  let totalSent = 0;
  let totalAcked = 0;
  let totalErrors = 0;

  async function runClient(index: number): Promise<void> {
    const ws = new WebSocket(`${wsBaseUrl}/ws/incidents/${incidentId}/chat`, {
      headers: { Origin: "http://localhost:5173", Cookie: sessionCookie },
    });

    // Attach the message listener from the moment the socket is created — the server sends
    // "connected" immediately after upgrade, which can otherwise arrive before a listener
    // attached only after awaiting the "open" event, causing a silent deadlock. Mirrors
    // backend/src/test/chat/chatWebsocket.test.ts's own `connect()` helper for the same reason.
    let acked = 0;
    let resolveConnected: (() => void) | undefined;
    let resolveDone: (() => void) | undefined;
    const connectedAck = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    ws.on("message", (raw: Buffer) => {
      const msg = JSON.parse(raw.toString()) as { type: string; requestId?: string };
      if (msg.type === "connected") {
        resolveConnected?.();
        return;
      }
      // "message" frames are the server's broadcast of *other* clients' sends to everyone else on
      // the same Incident — every client here is on the same Incident, so each send is broadcast
      // to the other 14. Only count responses that answer one of *this* client's own requestIds.
      if (msg.type === "message" || !msg.requestId?.startsWith(`c${index}-`)) return;
      if (msg.type === "sent") totalAcked += 1;
      else totalErrors += 1;
      acked += 1;
      if (acked === MESSAGES_PER_CLIENT) resolveDone?.();
    });

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("unexpected-response", (_req, res) => reject(new Error(`unexpected-response ${res.statusCode}`)));
      ws.once("error", reject);
    });

    const timeout = (label: string) =>
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`client ${index} timed out ${label} (got ${acked}/${MESSAGES_PER_CLIENT} acks)`)), PER_CLIENT_TIMEOUT_MS);
      });

    // Must wait for the server's own "connected" frame before sending — sending immediately on
    // the client-side "open" event races the server's async connection setup (it hasn't attached
    // its own message listener yet), silently dropping the first frames. This is the exact same
    // ordering every test in chatWebsocket.test.ts already follows.
    await Promise.race([connectedAck, timeout("waiting for the initial 'connected' frame")]);

    for (let i = 0; i < MESSAGES_PER_CLIENT; i += 1) {
      ws.send(JSON.stringify({ type: "send", body: `load client ${index} message ${i}`, requestId: `c${index}-m${i}` }));
      totalSent += 1;
    }
    await Promise.race([done, timeout("waiting for send acknowledgements")]);
    ws.close();
  }

  await Promise.all(Array.from({ length: CLIENT_COUNT }, (_, i) => runClient(i)));
  const elapsedMs = performance.now() - start;

  const persisted = await db.select({ id: chatMessages.id }).from(chatMessages).where(eq(chatMessages.incidentId, incidentId));

  console.log(`Sent: ${totalSent}  Acked "sent": ${totalAcked}  Errors/rate-limited: ${totalErrors}`);
  console.log(`Persisted rows in DB: ${persisted.length} (expected ${totalAcked})`);
  console.log(`Elapsed: ${elapsedMs.toFixed(1)}ms`);
  console.log(persisted.length === totalAcked ? "No dropped/corrupted messages observed." : "MISMATCH — investigate.");
  } finally {
    // Always cleans up, even on error — see claude/prompts/24-testing.md, "Load harness cleanup".
    if (incidentIdForCleanup) {
      await db.delete(auditLogs).where(eq(auditLogs.incidentId, incidentIdForCleanup));
      await db.delete(chatMessages).where(eq(chatMessages.incidentId, incidentIdForCleanup));
      await db.delete(incidents).where(eq(incidents.id, incidentIdForCleanup));
    }
    if (adminUserId) {
      await db.delete(auditLogs).where(eq(auditLogs.actorId, adminUserId));
      await db.delete(users).where(eq(users.id, adminUserId));
    }
    await app.close();
    await closeDb();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
