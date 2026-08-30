/**
 * Integration tests for Module 12's read-only Command Center aggregate endpoint
 * (`GET /incidents/:id/command-center`), run end-to-end against a live PostgreSQL database with
 * the mock notification provider. Skipped when DATABASE_URL isn't reachable. Runs sequentially
 * with other backend test files (`fileParallelism: false`).
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
  notificationDeliveryEvents,
  notificationDispatchAttempts,
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

describe.skipIf(!process.env.DATABASE_URL)("incident command center route (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C12";
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

  async function createActor(roleCode?: string): Promise<{ id: string; token: string; csrf: string }> {
    const label = roleCode ?? "noperm";
    const email = `test-cc-${label.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `CC Test ${label}`, passwordHash })
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

  function authHeaders(session: { token: string; csrf: string }) {
    return {
      cookies: { [config.sessionCookieName]: session.token, [config.csrfCookieName]: session.csrf },
      headers: { "x-csrf-token": session.csrf },
    };
  }

  let admin: { id: string; token: string; csrf: string };
  let auditor: { id: string; token: string; csrf: string };
  let responder: { id: string; token: string; csrf: string };
  let noPerm: { id: string; token: string; csrf: string };

  beforeAll(async () => {
    admin = await createActor("ADMIN");
    auditor = await createActor("AUDITOR");
    responder = await createActor("RESPONDER");
    noPerm = await createActor();
  });

  afterAll(async () => {
    for (const id of createdAlertIds) {
      await db.delete(auditLogs).where(eq(auditLogs.resourceId, id));
      await db.delete(notificationDeliveryEvents).where(eq(notificationDeliveryEvents.alertId, id));
      await db.delete(notificationDispatchAttempts).where(eq(notificationDispatchAttempts.alertId, id));
      await db.delete(alertRecipients).where(eq(alertRecipients.alertId, id));
      await db.delete(alertContactSelections).where(eq(alertContactSelections.alertId, id));
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

  async function createContact(): Promise<{ id: string; mobilePhone: string }> {
    const suffix = randomUUID().slice(0, 8);
    const mobilePhone = `+1202${suffix.slice(0, 7).padStart(7, "0")}`;
    const [row] = await db
      .insert(contacts)
      .values({ firstName: `CC-${suffix}`, lastName: "Test", mobilePhone })
      .returning({ id: contacts.id });
    createdContactIds.push(row!.id);
    return { id: row!.id, mobilePhone };
  }

  async function createRawIncident(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/incidents",
      ...authHeaders(admin),
      payload: { title: `Command Center Test Incident ${tag}-${randomUUID().slice(0, 6)}`, severity: "warning" },
    });
    const id = response.json().incident.id as string;
    createdIncidentIds.push(id);
    return id;
  }

  /** Creates, READYs, and dispatches an Alert with one SMS recipient, linked to the given Incident. */
  async function createDispatchedAlert(incidentId: string): Promise<{ id: string; recipientId: string }> {
    const contact = await createContact();
    const createResponse = await app.inject({
      method: "POST",
      url: "/alerts",
      ...authHeaders(admin),
      payload: {
        title: `Command Center Alert ${tag}-${randomUUID().slice(0, 6)}`,
        channel: "sms",
        contentSource: "adhoc",
        body: "Hi {{firstName}}",
        incidentId,
        contactIds: [contact.id],
      },
    });
    const id = createResponse.json().alert.id as string;
    createdAlertIds.push(id);
    await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
    await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });
    const recipients = await app.inject({ method: "GET", url: `/alerts/${id}/recipients`, ...authHeaders(admin) });
    const recipientId = recipients.json().items[0].id as string;
    return { id, recipientId };
  }

  async function mockDeliver(alertId: string, recipientId: string, status: string) {
    return app.inject({
      method: "POST",
      url: `/alerts/${alertId}/recipients/${recipientId}/mock-delivery`,
      ...authHeaders(admin),
      payload: { status },
    });
  }

  async function getCommandCenter(incidentId: string, actor = admin) {
    return app.inject({ method: "GET", url: `/incidents/${incidentId}/command-center`, ...authHeaders(actor) });
  }

  describe("authentication and authorization", () => {
    it("requires authentication", async () => {
      const incidentId = await createRawIncident();
      const response = await app.inject({ method: "GET", url: `/incidents/${incidentId}/command-center` });
      expect(response.statusCode).toBe(401);
    });

    it("rejects a user with no incidents.command_center.read permission", async () => {
      const incidentId = await createRawIncident();
      const response = await getCommandCenter(incidentId, noPerm);
      expect(response.statusCode).toBe(403);
    });

    it("ADMIN, AUDITOR, and RESPONDER can all read (global permission model)", async () => {
      const incidentId = await createRawIncident();
      for (const actor of [admin, auditor, responder]) {
        const response = await getCommandCenter(incidentId, actor);
        expect(response.statusCode).toBe(200);
      }
    });

    it("returns 404 for a nonexistent Incident", async () => {
      const response = await getCommandCenter(randomUUID());
      expect(response.statusCode).toBe(404);
    });
  });

  describe("safe aggregate projection", () => {
    it("returns incident, participantsSummary, alertsSummary, recentAlerts, recentTimeline sections", async () => {
      const incidentId = await createRawIncident();
      const response = await getCommandCenter(incidentId);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.incident.id).toBe(incidentId);
      expect(body).toHaveProperty("participantsSummary");
      expect(body).toHaveProperty("alertsSummary");
      expect(body).toHaveProperty("recentAlerts");
      expect(body).toHaveProperty("recentTimeline");
    });

    it("never exposes recipient destination PII anywhere in the response", async () => {
      const incidentId = await createRawIncident();
      const { id, recipientId } = await createDispatchedAlert(incidentId);
      const [contactRow] = await db
        .select({ mobilePhone: contacts.mobilePhone })
        .from(alertRecipients)
        .innerJoin(contacts, eq(contacts.id, alertRecipients.contactId))
        .where(eq(alertRecipients.id, recipientId));
      await mockDeliver(id, recipientId, "delivered");

      const response = await getCommandCenter(incidentId);
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain(contactRow!.mobilePhone);
    });

    it("reflects exact participant counts", async () => {
      const incidentId = await createRawIncident();
      const contact = await createContact();
      await app.inject({
        method: "POST",
        url: `/incidents/${incidentId}/participants/contacts`,
        ...authHeaders(admin),
        payload: { contactId: contact.id },
      });

      const response = await getCommandCenter(incidentId);
      expect(response.json().participantsSummary).toMatchObject({ total: 1, registeredUsers: 0, contacts: 1 });
    });

    it("reflects the assigned commander", async () => {
      const incidentId = await createRawIncident();
      await app.inject({
        method: "POST",
        url: `/incidents/${incidentId}/commander`,
        ...authHeaders(admin),
        payload: { userId: admin.id },
      });
      const response = await getCommandCenter(incidentId);
      expect(response.json().incident.commander).toMatchObject({ id: admin.id });
    });

    it("reflects lifecycle changes", async () => {
      const incidentId = await createRawIncident();
      let response = await getCommandCenter(incidentId);
      expect(response.json().incident.status).toBe("open");

      await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(admin) });
      response = await getCommandCenter(incidentId);
      expect(response.json().incident.status).toBe("active");
    });
  });

  describe("alert communication summary", () => {
    it("reports exact mixed-outcome aggregate delivery counts across all of the incident's Alerts", async () => {
      const incidentId = await createRawIncident();
      const alertA = await createDispatchedAlert(incidentId);
      const alertB = await createDispatchedAlert(incidentId);
      await createDispatchedAlert(incidentId); // left pending, deliberately never simulated

      await mockDeliver(alertA.id, alertA.recipientId, "delivered");
      await mockDeliver(alertB.id, alertB.recipientId, "failed");

      const response = await getCommandCenter(incidentId);
      const body = response.json();
      expect(body.alertsSummary).toMatchObject({ total: 3, submitted: 3 });
      expect(body.alertsSummary.delivery).toMatchObject({ total: 3, delivered: 1, failed: 1, deliveryPending: 1 });
    });

    it("counts a DRAFT Alert in totals without affecting delivery counts", async () => {
      const incidentId = await createRawIncident();
      const contact = await createContact();
      const createResponse = await app.inject({
        method: "POST",
        url: "/alerts",
        ...authHeaders(admin),
        payload: { title: `Draft CC Alert ${tag}`, channel: "sms", contentSource: "adhoc", body: "Hi", incidentId, contactIds: [contact.id] },
      });
      createdAlertIds.push(createResponse.json().alert.id);

      const response = await getCommandCenter(incidentId);
      expect(response.json().alertsSummary).toMatchObject({ total: 1, draft: 1, submitted: 0 });
      expect(response.json().alertsSummary.delivery).toMatchObject({ total: 0 });
    });
  });

  describe("recent alerts", () => {
    it("lists recent Alerts with safe summary fields and a per-alert delivery summary", async () => {
      const incidentId = await createRawIncident();
      const { id, recipientId } = await createDispatchedAlert(incidentId);
      await mockDeliver(id, recipientId, "delivered");

      const response = await getCommandCenter(incidentId);
      const recent = response.json().recentAlerts as Array<{ id: string; deliverySummary: { delivered: number } }>;
      const match = recent.find((a) => a.id === id);
      expect(match).toBeDefined();
      expect(match!.deliverySummary.delivered).toBe(1);
    });

    it("bounds recentAlerts to a small number even with many Alerts on the Incident", async () => {
      const incidentId = await createRawIncident();
      for (let i = 0; i < 7; i += 1) {
        const contact = await createContact();
        const createResponse = await app.inject({
          method: "POST",
          url: "/alerts",
          ...authHeaders(admin),
          payload: { title: `Bulk CC Alert ${tag}-${i}`, channel: "sms", contentSource: "adhoc", body: "Hi", incidentId, contactIds: [contact.id] },
        });
        createdAlertIds.push(createResponse.json().alert.id);
      }
      const response = await getCommandCenter(incidentId);
      expect(response.json().alertsSummary.total).toBe(7);
      expect(response.json().recentAlerts.length).toBeLessThanOrEqual(5);
    });
  });

  describe("CLOSED Incident behavior", () => {
    it("remains readable after the Incident is closed", async () => {
      const incidentId = await createRawIncident();
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/resolve`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/close`, ...authHeaders(admin) });

      const response = await getCommandCenter(incidentId);
      expect(response.statusCode).toBe(200);
      expect(response.json().incident.status).toBe("closed");
    });

    it("does not itself introduce any bypass of the existing CLOSED mutation rules", async () => {
      const incidentId = await createRawIncident();
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/resolve`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/close`, ...authHeaders(admin) });

      const patchResponse = await app.inject({
        method: "PATCH",
        url: `/incidents/${incidentId}`,
        ...authHeaders(admin),
        payload: { title: "Attempted edit after close" },
      });
      expect(patchResponse.statusCode).toBe(409);
    });
  });
});
