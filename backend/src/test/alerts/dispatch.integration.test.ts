/**
 * Integration tests for the Module 10 dispatch route, run end-to-end against a live PostgreSQL
 * database with the default mock provider (always accepts — see providers/mockProvider.ts).
 * Skipped when DATABASE_URL isn't reachable. Runs sequentially with other backend test files
 * (`fileParallelism: false`).
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
  templates,
  incidents,
  alerts,
  alertRecipients,
  alertContactSelections,
  alertGroupSelections,
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

describe.skipIf(!process.env.DATABASE_URL)("alert dispatch routes (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C10";
  const createdUserIds: string[] = [];
  const createdContactIds: string[] = [];
  const createdTemplateIds: string[] = [];
  const createdIncidentIds: string[] = [];
  const createdAlertIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode: string): Promise<{ id: string; token: string; csrf: string }> {
    const email = `test-dispatch-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `Dispatch Test ${roleCode}`, passwordHash })
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
    for (const id of createdTemplateIds) {
      await db.delete(templates).where(eq(templates.id, id));
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

  async function createContact(overrides: { mobilePhone?: string } = {}): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const [row] = await db
      .insert(contacts)
      .values({
        firstName: `Dispatch-${suffix}`,
        lastName: "Test",
        email: `dispatch-${suffix}@example.invalid`,
        mobilePhone: overrides.mobilePhone ?? `+1555${suffix.slice(0, 7).padStart(7, "0")}`,
      })
      .returning({ id: contacts.id });
    createdContactIds.push(row!.id);
    return row!.id;
  }

  async function createRawIncident(overrides: { status?: "open" | "closed" } = {}): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/incidents",
      ...authHeaders(admin),
      payload: { title: `Dispatch Test Incident ${tag}-${randomUUID().slice(0, 6)}`, severity: "warning" },
    });
    const id = response.json().incident.id as string;
    createdIncidentIds.push(id);
    if (overrides.status === "closed") {
      await app.inject({ method: "POST", url: `/incidents/${id}/activate`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${id}/resolve`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${id}/close`, ...authHeaders(admin) });
    }
    return id;
  }

  /** Creates a DRAFT Alert, gives it one eligible Contact, and (unless told otherwise) READYs it. */
  async function createAlert(overrides: {
    incidentId?: string;
    ready?: boolean;
    contactId?: string;
  } = {}): Promise<{ id: string; contactId: string }> {
    const contactId = overrides.contactId ?? (await createContact());
    const createResponse = await app.inject({
      method: "POST",
      url: "/alerts",
      ...authHeaders(admin),
      payload: {
        title: `Dispatch Alert ${tag}-${randomUUID().slice(0, 6)}`,
        channel: "sms",
        contentSource: "adhoc",
        body: "Hi {{firstName}}",
        contactIds: [contactId],
        ...(overrides.incidentId ? { incidentId: overrides.incidentId } : {}),
      },
    });
    const id = createResponse.json().alert.id as string;
    createdAlertIds.push(id);

    if (overrides.ready !== false) {
      const readyResponse = await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      if (readyResponse.statusCode !== 200) {
        throw new Error(`ready failed: ${readyResponse.statusCode} ${readyResponse.body}`);
      }
    }
    return { id, contactId };
  }

  describe("authentication and authorization", () => {
    it("requires authentication", async () => {
      const { id } = await createAlert();
      const response = await app.inject({ method: "POST", url: `/alerts/${id}/dispatch` });
      expect(response.statusCode).toBe(401);
    });

    it("AUDITOR and RESPONDER are forbidden", async () => {
      for (const actor of [auditor, responder]) {
        const { id } = await createAlert();
        const response = await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(actor) });
        expect(response.statusCode).toBe(403);
      }
    });

    it("ADMIN, COMMUNICATION_MANAGER, and INCIDENT_COMMANDER can dispatch", async () => {
      for (const actor of [admin, commManager, incidentCommander]) {
        const { id } = await createAlert();
        const response = await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(actor) });
        expect(response.statusCode).toBe(200);
        expect(response.json().status).toBe("submitted");
      }
    });
  });

  describe("dispatch lifecycle", () => {
    it("rejects dispatching a DRAFT Alert", async () => {
      const { id } = await createAlert({ ready: false });
      const response = await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("alert_not_ready");
    });

    it("dispatches a READY Alert successfully", async () => {
      const { id } = await createAlert();
      const response = await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ alertId: id, status: "submitted", totalRecipients: 1, submitted: 1, submissionFailed: 0, pending: 0 });
    });

    it("rejects dispatching a CANCELLED Alert", async () => {
      const { id } = await createAlert({ ready: false });
      await app.inject({ method: "POST", url: `/alerts/${id}/cancel`, ...authHeaders(admin) });
      const response = await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("alert_cancelled");
    });

    it("rejects dispatching an Alert linked to a CLOSED Incident", async () => {
      const incidentId = await createRawIncident();
      const { id } = await createAlert({ incidentId, ready: false });
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/resolve`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/close`, ...authHeaders(admin) });

      const response = await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("incident_not_eligible");
    });
  });

  describe("idempotency", () => {
    it("a second dispatch request does not duplicate provider submissions", async () => {
      const { id } = await createAlert();
      const first = await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });
      expect(first.statusCode).toBe(200);
      expect(first.json().submitted).toBe(1);

      const second = await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toMatchObject({ status: "submitted", submitted: 1, submissionFailed: 0, pending: 0 });

      const attempts = await db.select().from(notificationDispatchAttempts).where(eq(notificationDispatchAttempts.alertId, id));
      expect(attempts).toHaveLength(1);
    });

    it("simultaneous dispatch requests do not duplicate submissions", async () => {
      const { id } = await createAlert();
      const [a, b] = await Promise.all([
        app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) }),
        app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) }),
      ]);
      const statuses = [a.statusCode, b.statusCode].sort();
      // Exactly one request wins the alert-level claim; the other observes "already in progress"
      // or (if it arrives after completion) the idempotent "already submitted" success path.
      expect(statuses[0]).toBe(200);
      expect([200, 409]).toContain(statuses[1]);

      const attempts = await db.select().from(notificationDispatchAttempts).where(eq(notificationDispatchAttempts.alertId, id));
      expect(attempts).toHaveLength(1);
    });
  });

  describe("snapshot-only dispatch", () => {
    it("dispatches the stored destination snapshot, unaffected by a later Contact change", async () => {
      const contactId = await createContact({ mobilePhone: "+15559990001" });
      const { id } = await createAlert({ contactId });

      await db.update(contacts).set({ mobilePhone: "+15559990099", firstName: "Changed" }).where(eq(contacts.id, contactId));

      const response = await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);

      const recipients = await app.inject({ method: "GET", url: `/alerts/${id}/recipients`, ...authHeaders(admin) });
      const recipient = recipients.json().items[0];
      expect(recipient.destination).toBe("+15559990001");
      expect(recipient.renderedBody).not.toContain("Changed");
    });

    it("dispatches the frozen Template-derived content, unaffected by a later Template edit", async () => {
      const [template] = await db
        .insert(templates)
        .values({ name: `Dispatch Template ${randomUUID()}`, channel: "sms", body: "Original {{firstName}}" })
        .returning({ id: templates.id });
      createdTemplateIds.push(template!.id);

      const contactId = await createContact();
      const createResponse = await app.inject({
        method: "POST",
        url: "/alerts",
        ...authHeaders(admin),
        payload: {
          title: `Template Dispatch Alert ${tag}`,
          channel: "sms",
          contentSource: "template",
          templateId: template!.id,
          contactIds: [contactId],
        },
      });
      const alertId = createResponse.json().alert.id as string;
      createdAlertIds.push(alertId);
      await app.inject({ method: "POST", url: `/alerts/${alertId}/ready`, ...authHeaders(admin) });

      await db.update(templates).set({ body: "Changed {{firstName}}" }).where(eq(templates.id, template!.id));

      await app.inject({ method: "POST", url: `/alerts/${alertId}/dispatch`, ...authHeaders(admin) });

      const recipients = await app.inject({ method: "GET", url: `/alerts/${alertId}/recipients`, ...authHeaders(admin) });
      expect(recipients.json().items[0].renderedBody).toContain("Original");
      expect(recipients.json().items[0].renderedBody).not.toContain("Changed");
    });
  });

  describe("cancellation rule (revised for Module 10)", () => {
    it("READY before any dispatch claim can still be cancelled", async () => {
      const { id } = await createAlert();
      const response = await app.inject({ method: "POST", url: `/alerts/${id}/cancel`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
      expect(response.json().alert.status).toBe("cancelled");
    });

    it("once dispatch has claimed/submitted a recipient, cancellation is rejected", async () => {
      const { id } = await createAlert();
      await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });

      const response = await app.inject({ method: "POST", url: `/alerts/${id}/cancel`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("dispatch_already_started");
    });
  });

  describe("audit and Incident timeline", () => {
    it("appends safe ALERT_DISPATCH_STARTED/COMPLETED timeline events with no PII", async () => {
      const incidentId = await createRawIncident();
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(admin) });
      const { id, contactId } = await createAlert({ incidentId, ready: false });
      await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });

      const timeline = await app.inject({ method: "GET", url: `/incidents/${incidentId}/timeline?order=asc`, ...authHeaders(admin) });
      const eventTypes = timeline.json().items.map((e: { eventType: string }) => e.eventType);
      expect(eventTypes).toEqual(expect.arrayContaining(["ALERT_DISPATCH_STARTED", "ALERT_DISPATCH_COMPLETED"]));

      const [contactRow] = await db.select({ mobilePhone: contacts.mobilePhone, firstName: contacts.firstName }).from(contacts).where(eq(contacts.id, contactId));
      const serialized = JSON.stringify(timeline.json());
      expect(serialized).not.toContain(contactRow!.mobilePhone);
      expect(serialized).not.toContain(contactRow!.firstName);
    });

    it("audit events contain no destination/body/credentials", async () => {
      const { id, contactId } = await createAlert();
      await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });

      const events = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, id));
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("ALERT_DISPATCH_STARTED");
      expect(eventTypes).toContain("ALERT_DISPATCH_COMPLETED");

      const [contactRow] = await db.select({ mobilePhone: contacts.mobilePhone }).from(contacts).where(eq(contacts.id, contactId));
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(contactRow!.mobilePhone);
      expect(serialized).not.toMatch(/token|secret|authtoken|accountsid/i);
    });
  });

  describe("recipient detail PII gate", () => {
    it("dispatch summary fields (provider, providerMessageId) require alerts.recipients.read", async () => {
      const { id } = await createAlert();
      await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });

      const forbidden = await app.inject({ method: "GET", url: `/alerts/${id}/recipients`, ...authHeaders(responder) });
      expect(forbidden.statusCode).toBe(403);

      const allowed = await app.inject({ method: "GET", url: `/alerts/${id}/recipients`, ...authHeaders(auditor) });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().items[0].provider).toBe("mock");
      expect(allowed.json().items[0].providerMessageId).toMatch(/^mock-mock-/);
    });
  });
});
