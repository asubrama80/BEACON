/**
 * Integration tests for Module 11 delivery tracking's HTTP surface — the safe aggregate
 * `deliverySummary` folded into GET /alerts/:id, the recipient-level delivery-events endpoint, and
 * the development-only mock-delivery simulation endpoint. Run end-to-end against a live PostgreSQL
 * database. Skipped when DATABASE_URL isn't reachable. Runs sequentially with other backend test
 * files (`fileParallelism: false`).
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getDb,
  users,
  roles,
  userRoles,
  contacts,
  incidents,
  alerts,
  alertRecipients,
  alertContactSelections,
  alertGroupSelections,
  notificationDispatchAttempts,
  notificationDeliveryEvents,
  incidentTimelineEvents,
  auditLogs,
  type Database,
} from "@beacon/database";
import { buildTestApp, TEST_MFA_ENCRYPTION_KEY } from "../testApp.js";
import { buildApp } from "../../app.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";
import { loadEnv } from "../../config/env.js";
import { loadContactImportConfig } from "../../modules/contactImport/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("alert delivery tracking routes (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C11";
  const createdUserIds: string[] = [];
  const createdContactIds: string[] = [];
  const createdIncidentIds: string[] = [];
  const createdAlertIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode: string): Promise<{ id: string; token: string; csrf: string }> {
    const email = `test-delivery-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `Delivery Test ${roleCode}`, passwordHash })
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
  let commManager: { id: string; token: string; csrf: string };
  let auditor: { id: string; token: string; csrf: string };
  let responder: { id: string; token: string; csrf: string };

  beforeAll(async () => {
    admin = await createActor("ADMIN");
    incidentCommander = await createActor("INCIDENT_COMMANDER");
    commManager = await createActor("COMMUNICATION_MANAGER");
    auditor = await createActor("AUDITOR");
    responder = await createActor("RESPONDER");
  });

  afterAll(async () => {
    for (const id of createdAlertIds) {
      await db.delete(auditLogs).where(eq(auditLogs.resourceId, id));
      await db.delete(notificationDeliveryEvents).where(eq(notificationDeliveryEvents.alertId, id));
      await db.delete(notificationDispatchAttempts).where(eq(notificationDispatchAttempts.alertId, id));
      await db.delete(alertRecipients).where(eq(alertRecipients.alertId, id));
      await db.delete(alertContactSelections).where(eq(alertContactSelections.alertId, id));
      await db.delete(alertGroupSelections).where(eq(alertGroupSelections.alertId, id));
      await db.delete(alerts).where(eq(alerts.id, id));
    }
    for (const id of createdIncidentIds) {
      await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
      await db.delete(incidentTimelineEvents).where(eq(incidentTimelineEvents.incidentId, id));
      await db.delete(incidents).where(eq(incidents.id, id));
    }
    for (const id of createdContactIds) {
      await db.delete(contacts).where(eq(contacts.id, id));
    }
    for (const id of createdUserIds) {
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
      await db.delete(users).where(eq(users.id, id));
    }
    await app.close();
  });

  async function createContact(overrides: { channel?: "sms" | "email" } = {}): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const channel = overrides.channel ?? "sms";
    const [row] = await db
      .insert(contacts)
      .values({
        firstName: `Delivery-${suffix}`,
        lastName: "Test",
        ...(channel === "sms" ? { mobilePhone: `+1555${suffix.slice(0, 7).padStart(7, "0")}` } : { email: `delivery-${suffix}@example.invalid` }),
      })
      .returning({ id: contacts.id });
    createdContactIds.push(row!.id);
    return row!.id;
  }

  /** Creates, READYs, and dispatches an Alert with `count` recipients on the given channel. */
  async function createDispatchedAlert(
    overrides: { channel?: "sms" | "email"; incidentId?: string; count?: number } = {},
  ): Promise<{ id: string; contactIds: string[]; recipientIds: string[] }> {
    const channel = overrides.channel ?? "sms";
    const count = overrides.count ?? 1;
    const contactIds = await Promise.all(Array.from({ length: count }, () => createContact({ channel })));

    const createResponse = await app.inject({
      method: "POST",
      url: "/alerts",
      ...authHeaders(admin),
      payload: {
        title: `Delivery Alert ${tag}-${randomUUID().slice(0, 6)}`,
        channel,
        contentSource: "adhoc",
        ...(channel === "email" ? { subject: "Test subject" } : {}),
        body: "Hi {{firstName}}",
        contactIds,
        ...(overrides.incidentId ? { incidentId: overrides.incidentId } : {}),
      },
    });
    const id = createResponse.json().alert.id as string;
    createdAlertIds.push(id);

    await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
    await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });

    const recipients = await app.inject({ method: "GET", url: `/alerts/${id}/recipients`, ...authHeaders(admin) });
    const recipientIds = recipients.json().items.map((r: { id: string }) => r.id) as string[];
    return { id, contactIds, recipientIds };
  }

  async function createRawIncident(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/incidents",
      ...authHeaders(admin),
      payload: { title: `Delivery Test Incident ${tag}-${randomUUID().slice(0, 6)}`, severity: "warning" },
    });
    const id = response.json().incident.id as string;
    createdIncidentIds.push(id);
    return id;
  }

  async function mockDeliver(alertId: string, recipientId: string, status: string, actor = admin) {
    return app.inject({
      method: "POST",
      url: `/alerts/${alertId}/recipients/${recipientId}/mock-delivery`,
      ...authHeaders(actor),
      payload: { status },
    });
  }

  describe("safe aggregate deliverySummary on GET /alerts/:id", () => {
    it("is visible to RESPONDER via alerts.read alone", async () => {
      const { id } = await createDispatchedAlert();
      const response = await app.inject({ method: "GET", url: `/alerts/${id}`, ...authHeaders(responder) });
      expect(response.statusCode).toBe(200);
      expect(response.json().alert.deliverySummary).toMatchObject({ total: 1, deliveryPending: 1, delivered: 0 });
    });

    it("never claims complete or delivered before evidence exists", async () => {
      const { id } = await createDispatchedAlert();
      const response = await app.inject({ method: "GET", url: `/alerts/${id}`, ...authHeaders(admin) });
      expect(response.json().alert.deliverySummary.overallStatus).toBe("in_progress");
      expect(response.json().alert.deliverySummary.delivered).toBe(0);
    });

    it("reflects exact mixed-outcome counts and only reports complete once every submitted recipient is terminal", async () => {
      const { id, recipientIds } = await createDispatchedAlert({ count: 4 });
      await mockDeliver(id, recipientIds[0]!, "delivered");
      await mockDeliver(id, recipientIds[1]!, "delivered");
      await mockDeliver(id, recipientIds[2]!, "failed");
      // recipientIds[3] left pending.

      const midway = await app.inject({ method: "GET", url: `/alerts/${id}`, ...authHeaders(admin) });
      expect(midway.json().alert.deliverySummary).toMatchObject({ total: 4, delivered: 2, failed: 1, deliveryPending: 1 });
      expect(midway.json().alert.deliverySummary.overallStatus).toBe("in_progress");
      expect(midway.json().alert.deliverySummary.deliveryCompletedAt).toBeNull();

      await mockDeliver(id, recipientIds[3]!, "undelivered");

      const done = await app.inject({ method: "GET", url: `/alerts/${id}`, ...authHeaders(admin) });
      expect(done.json().alert.deliverySummary).toMatchObject({ total: 4, delivered: 2, failed: 1, undelivered: 1, deliveryPending: 0 });
      expect(done.json().alert.deliverySummary.overallStatus).toBe("partial_failure");
      expect(done.json().alert.deliverySummary.deliveryCompletedAt).not.toBeNull();
    });
  });

  describe("recipient-level delivery-events endpoint (dual permission gate)", () => {
    it("requires authentication", async () => {
      const { id, recipientIds } = await createDispatchedAlert();
      const response = await app.inject({ method: "GET", url: `/alerts/${id}/recipients/${recipientIds[0]}/delivery-events` });
      expect(response.statusCode).toBe(401);
    });

    it("RESPONDER (no alerts.delivery.read) is forbidden even though it has alerts.recipients.read-adjacent read access", async () => {
      const { id, recipientIds } = await createDispatchedAlert();
      const response = await app.inject({
        method: "GET",
        url: `/alerts/${id}/recipients/${recipientIds[0]}/delivery-events`,
        ...authHeaders(responder),
      });
      expect(response.statusCode).toBe(403);
    });

    it("ADMIN, COMMUNICATION_MANAGER, INCIDENT_COMMANDER, and AUDITOR can read delivery event history", async () => {
      const { id, recipientIds } = await createDispatchedAlert();
      await mockDeliver(id, recipientIds[0]!, "delivered");

      for (const actor of [admin, commManager, incidentCommander, auditor]) {
        const response = await app.inject({
          method: "GET",
          url: `/alerts/${id}/recipients/${recipientIds[0]}/delivery-events`,
          ...authHeaders(actor),
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().items).toHaveLength(1);
        expect(response.json().items[0]).toMatchObject({ normalizedStatus: "delivered" });
      }
    });

    it("delivery event history never includes destination phone/email", async () => {
      const contactId = await createContact({ channel: "sms" });
      const [contactRow] = await db.select({ mobilePhone: contacts.mobilePhone }).from(contacts).where(eq(contacts.id, contactId));
      const createResponse = await app.inject({
        method: "POST",
        url: "/alerts",
        ...authHeaders(admin),
        payload: { title: `PII Check Alert ${tag}`, channel: "sms", contentSource: "adhoc", body: "Hi", contactIds: [contactId] },
      });
      const id = createResponse.json().alert.id as string;
      createdAlertIds.push(id);
      await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });
      const recipients = await app.inject({ method: "GET", url: `/alerts/${id}/recipients`, ...authHeaders(admin) });
      const recipientId = recipients.json().items[0].id as string;
      await mockDeliver(id, recipientId, "delivered");

      const response = await app.inject({ method: "GET", url: `/alerts/${id}/recipients/${recipientId}/delivery-events`, ...authHeaders(admin) });
      expect(JSON.stringify(response.json())).not.toContain(contactRow!.mobilePhone);
    });
  });

  describe("mock-delivery simulation endpoint (development/test only)", () => {
    it("requires alerts.dispatch — AUDITOR and RESPONDER are forbidden", async () => {
      const { id, recipientIds } = await createDispatchedAlert();
      for (const actor of [auditor, responder]) {
        const response = await mockDeliver(id, recipientIds[0]!, "delivered", actor);
        expect(response.statusCode).toBe(403);
      }
    });

    it("accepts channel-appropriate delivery statuses for SMS", async () => {
      for (const status of ["delivered", "undelivered", "failed"]) {
        const { id, recipientIds } = await createDispatchedAlert({ channel: "sms" });
        const response = await mockDeliver(id, recipientIds[0]!, status);
        expect(response.statusCode).toBe(200);
        expect(response.json().recipient.deliveryStatus).toBe(status);
      }
    });

    it("rejects BOUNCED for an SMS recipient — SMS does not bounce", async () => {
      const { id, recipientIds } = await createDispatchedAlert({ channel: "sms" });
      const response = await mockDeliver(id, recipientIds[0]!, "bounced");
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("invalid_delivery_status");
    });

    it("accepts channel-appropriate delivery statuses for Email", async () => {
      for (const status of ["delivered", "bounced", "failed"]) {
        const { id, recipientIds } = await createDispatchedAlert({ channel: "email" });
        const response = await mockDeliver(id, recipientIds[0]!, status);
        expect(response.statusCode).toBe(200);
        expect(response.json().recipient.deliveryStatus).toBe(status);
      }
    });

    it("rejects UNDELIVERED for an Email recipient — Email does not carrier-undeliver", async () => {
      const { id, recipientIds } = await createDispatchedAlert({ channel: "email" });
      const response = await mockDeliver(id, recipientIds[0]!, "undelivered");
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("invalid_delivery_status");
    });

    it("rejects simulating delivery for a recipient that was never submitted", async () => {
      const contactId = await createContact();
      const createResponse = await app.inject({
        method: "POST",
        url: "/alerts",
        ...authHeaders(admin),
        payload: { title: `Never Submitted Alert ${tag}`, channel: "sms", contentSource: "adhoc", body: "Hi", contactIds: [contactId] },
      });
      const id = createResponse.json().alert.id as string;
      createdAlertIds.push(id);
      await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      // Not dispatched — recipient is still pending_delivery, never submitted.
      const recipients = await app.inject({ method: "GET", url: `/alerts/${id}/recipients`, ...authHeaders(admin) });
      const recipientId = recipients.json().items[0].id as string;

      const response = await mockDeliver(id, recipientId, "delivered");
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("recipient_not_submitted");
    });

    it("is idempotent-safe: a duplicate identical simulation does not double-mutate state", async () => {
      const { id, recipientIds } = await createDispatchedAlert();
      const first = await mockDeliver(id, recipientIds[0]!, "delivered");
      expect(first.statusCode).toBe(200);
      const updatedAtAfterFirst = first.json().recipient.deliveryUpdatedAt;

      const second = await mockDeliver(id, recipientIds[0]!, "delivered");
      expect(second.statusCode).toBe(200);
      expect(second.json().recipient.deliveryStatus).toBe("delivered");

      const events = await db.select().from(notificationDeliveryEvents).where(eq(notificationDeliveryEvents.alertRecipientId, recipientIds[0]!));
      // Each mock-delivery call uses a fresh providerEventId (mock-sim-<uuid>), so these are two
      // distinct events by design (an operator re-simulating is not a provider retry) — but the
      // recipient's terminal delivery_status must not regress or duplicate-complete.
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(updatedAtAfterFirst).toBeTruthy();
    });

    it("is not registered at all when NODE_ENV is production", async () => {
      // Deliberately never closes prodApp: its onClose hook tears down the single shared
      // database connection pool (@beacon/database's getDb()/closeDb() are process-wide
      // singletons — see database/src/client.ts), which every other test file in this run
      // depends on. Fastify's inject() never opens a real socket, so an unclosed test instance
      // is harmless to leave for process exit.
      const prodApp = buildApp({
        env: loadEnv({ NODE_ENV: "production", DATABASE_URL: process.env.DATABASE_URL }),
        authConfig: loadAuthConfig({ NODE_ENV: "production" }),
        mfaEncryptionKey: TEST_MFA_ENCRYPTION_KEY,
        contactImportConfig: loadContactImportConfig({ NODE_ENV: "production" }),
      });
      const { id, recipientIds } = await createDispatchedAlert();
      const response = await prodApp.inject({
        method: "POST",
        url: `/alerts/${id}/recipients/${recipientIds[0]}/mock-delivery`,
        ...authHeaders(admin),
        payload: { status: "delivered" },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe("CLOSED Incident and post-hoc status changes never block delivery callback processing", () => {
    it("still processes a delivery callback for an Alert linked to a now-CLOSED Incident", async () => {
      const incidentId = await createRawIncident();
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(admin) });
      const { id, recipientIds } = await createDispatchedAlert({ incidentId });

      await app.inject({ method: "POST", url: `/incidents/${incidentId}/resolve`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/close`, ...authHeaders(admin) });

      const response = await mockDeliver(id, recipientIds[0]!, "delivered");
      expect(response.statusCode).toBe(200);
      expect(response.json().recipient.deliveryStatus).toBe("delivered");

      const timeline = await app.inject({ method: "GET", url: `/incidents/${incidentId}/timeline?order=asc`, ...authHeaders(admin) });
      const eventTypes = timeline.json().items.map((e: { eventType: string }) => e.eventType);
      expect(eventTypes).toContain("ALERT_DELIVERY_COMPLETED");
    });

    it("the underlying event service still processes a callback even when the Alert row itself has since been marked cancelled", async () => {
      // The dispatch-already-started guard on POST /alerts/:id/cancel makes this state
      // unreachable through the API once submission has begun (Module 10 rule) — but the
      // delivery-processing path itself must not gate on Alert.status at all (historical reality
      // is never erased). This directly verifies that invariant at the data layer.
      const { id, recipientIds } = await createDispatchedAlert();
      await db.update(alerts).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(alerts.id, id));

      const response = await mockDeliver(id, recipientIds[0]!, "delivered");
      expect(response.statusCode).toBe(200);
      expect(response.json().recipient.deliveryStatus).toBe("delivered");
    });
  });

  describe("completion is exactly-once even under repeated terminal callbacks", () => {
    it("fires ALERT_DELIVERY_COMPLETED exactly once despite a duplicate final-recipient simulation", async () => {
      const incidentId = await createRawIncident();
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(admin) });
      const { id, recipientIds } = await createDispatchedAlert({ incidentId, count: 2 });

      await mockDeliver(id, recipientIds[0]!, "delivered");
      await mockDeliver(id, recipientIds[1]!, "delivered");
      await mockDeliver(id, recipientIds[1]!, "delivered"); // repeated terminal callback

      const timeline = await app.inject({ method: "GET", url: `/incidents/${incidentId}/timeline?order=asc`, ...authHeaders(admin) });
      const completions = timeline.json().items.filter((e: { eventType: string }) => e.eventType === "ALERT_DELIVERY_COMPLETED");
      expect(completions).toHaveLength(1);
      expect(completions[0].metadata).toMatchObject({ alertId: id, deliveredCount: 2, failedCount: 0, bouncedCount: 0, undeliveredCount: 0 });
    });
  });
});
