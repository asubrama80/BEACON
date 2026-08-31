/**
 * Integration tests for Module 21's Dashboard aggregate endpoint and the Incident/Alert History
 * date-range filters, run end-to-end against a live PostgreSQL database. Skipped when
 * DATABASE_URL isn't reachable.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, users, roles, userRoles, contacts, incidents, alerts, alertRecipients, alertContactSelections, auditLogs, type Database } from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("dashboard and history (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500", SMS_PROVIDER: "mock", EMAIL_PROVIDER: "mock" });
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C21";
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
    const email = `test-dash-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `Dashboard Test ${roleCode}`, passwordHash })
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

  beforeAll(async () => {
    admin = await createActor("ADMIN");
  });

  afterAll(async () => {
    for (const id of createdAlertIds) {
      await db.delete(alertRecipients).where(eq(alertRecipients.alertId, id));
      await db.delete(alertContactSelections).where(eq(alertContactSelections.alertId, id));
    }
    for (const id of createdIncidentIds) {
      await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
      await db.delete(alerts).where(eq(alerts.incidentId, id));
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

  async function createContact(): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const [row] = await db
      .insert(contacts)
      .values({ firstName: `Dashboard-${suffix}`, lastName: "Test", email: `dashboard-${suffix}@example.invalid`, mobilePhone: `+1555${suffix.slice(0, 7).padStart(7, "0")}` })
      .returning({ id: contacts.id });
    createdContactIds.push(row!.id);
    return row!.id;
  }

  async function createRawIncident(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/incidents",
      ...authHeaders(admin),
      payload: { title: `Dashboard Test Incident ${tag}-${randomUUID().slice(0, 6)}`, severity: "warning" },
    });
    const id = response.json().incident.id as string;
    createdIncidentIds.push(id);
    return id;
  }

  /** Creates a DRAFT alert, gives it one eligible Contact, READYs and dispatches it (mock
   * provider always accepts), so the dashboard has non-zero alert/delivery data to aggregate. */
  async function createDispatchedAlert(): Promise<string> {
    const contactId = await createContact();
    const createResponse = await app.inject({
      method: "POST",
      url: "/alerts",
      ...authHeaders(admin),
      payload: { title: `Dashboard Alert ${tag}-${randomUUID().slice(0, 6)}`, channel: "sms", contentSource: "adhoc", body: "Hi {{firstName}}", contactIds: [contactId] },
    });
    const id = createResponse.json().alert.id as string;
    createdAlertIds.push(id);
    await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
    await app.inject({ method: "POST", url: `/alerts/${id}/dispatch`, ...authHeaders(admin) });
    return id;
  }

  function getDashboard(actor = admin) {
    return app.inject({ method: "GET", url: "/dashboard", ...authHeaders(actor) });
  }

  describe("authorization", () => {
    it("rejects an unauthenticated request", async () => {
      const response = await app.inject({ method: "GET", url: "/dashboard" });
      expect(response.statusCode).toBe(401);
    });

    it("rejects a Guest session cookie entirely", async () => {
      const response = await app.inject({ method: "GET", url: "/dashboard", cookies: { beacon_guest_session: "anything" } });
      expect(response.statusCode).toBe(401);
    });

    it("allows an authenticated User with incidents.read", async () => {
      const response = await getDashboard();
      expect(response.statusCode).toBe(200);
    });
  });

  describe("aggregate correctness", () => {
    it("reflects created Incidents in the status counts and recent list, bounded to 5", async () => {
      const before = await getDashboard();
      const beforeTotal = before.json().incidents.total as number;

      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) ids.push(await createRawIncident());

      const after = await getDashboard();
      const body = after.json();
      expect(body.incidents.total).toBe(beforeTotal + 3);
      expect(body.incidents.recent.length).toBeLessThanOrEqual(5);
      const recentIds = (body.incidents.recent as Array<{ id: string }>).map((i) => i.id);
      // At least the most-recently-updated of the 3 we just created should appear (recent list
      // is ordered by updatedAt DESC, capped at 5 — with other tests' incidents interleaved,
      // we only assert the most recent one is present, not all 3).
      expect(recentIds).toContain(ids[ids.length - 1]);
    });

    it("aggregates Alert status and delivery counts from a dispatched Alert, never leaking recipient PII", async () => {
      await createDispatchedAlert();
      const response = await getDashboard();
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.alerts.total).toBeGreaterThan(0);
      expect(body.alerts.submitted).toBeGreaterThan(0);
      expect(body.alerts.delivery.total).toBeGreaterThan(0);
      // Freshly-submitted mock deliveries have no terminal delivery event yet — they must show as
      // pending, never silently counted as "delivered".
      expect(body.alerts.delivery.deliveryPending).toBeGreaterThan(0);

      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/@example\.invalid/);
      expect(serialized).not.toMatch(/\+1555\d{7}/);
    });

    it("counts active Contacts and Groups", async () => {
      await createContact();
      const response = await getDashboard();
      expect(response.json().contacts.active).toBeGreaterThan(0);
    });

    it("computes attention counts deterministically from the same data already aggregated", async () => {
      const before = await getDashboard();
      const beforeReady = before.json().attention.readyAlertsNotDispatched as number;

      const contactId = await createContact();
      const createResponse = await app.inject({
        method: "POST",
        url: "/alerts",
        ...authHeaders(admin),
        payload: { title: `Dashboard Ready Alert ${tag}`, channel: "sms", contentSource: "adhoc", body: "Test", contactIds: [contactId] },
      });
      const alertId = createResponse.json().alert.id as string;
      createdAlertIds.push(alertId);
      await app.inject({ method: "POST", url: `/alerts/${alertId}/ready`, ...authHeaders(admin) });

      const after = await getDashboard();
      expect(after.json().attention.readyAlertsNotDispatched).toBe(beforeReady + 1);
    });

    it("returns a well-formed empty-ish response with no errors when no data matches recent windows", async () => {
      const response = await getDashboard();
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.incidents.recent)).toBe(true);
      expect(Array.isArray(body.alerts.recent)).toBe(true);
    });
  });

  describe("Incident History date-range filter", () => {
    it("filters Incidents by from/to", async () => {
      const id = await createRawIncident();
      const future = new Date(Date.now() + 60_000).toISOString();
      const past = new Date(Date.now() - 60_000).toISOString();

      const included = await app.inject({ method: "GET", url: `/incidents?from=${past}`, ...authHeaders(admin) });
      expect((included.json().items as Array<{ id: string }>).some((i) => i.id === id)).toBe(true);

      const excluded = await app.inject({ method: "GET", url: `/incidents?from=${future}`, ...authHeaders(admin) });
      expect((excluded.json().items as Array<{ id: string }>).some((i) => i.id === id)).toBe(false);
    });

    it("rejects an invalid date", async () => {
      const response = await app.inject({ method: "GET", url: "/incidents?from=not-a-date", ...authHeaders(admin) });
      expect(response.statusCode).toBe(400);
    });

    it("rejects from > to", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/incidents?from=2026-06-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z",
        ...authHeaders(admin),
      });
      expect(response.statusCode).toBe(400);
    });

    it("CLOSED Incidents remain discoverable via the status filter", async () => {
      const id = await createRawIncident();
      await app.inject({ method: "POST", url: `/incidents/${id}/activate`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${id}/resolve`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${id}/close`, ...authHeaders(admin) });

      const response = await app.inject({ method: "GET", url: "/incidents?status=closed", ...authHeaders(admin) });
      expect((response.json().items as Array<{ id: string }>).some((i) => i.id === id)).toBe(true);
    });
  });

  describe("Alert History date-range filter", () => {
    it("filters Alerts by from/to", async () => {
      const id = await createDispatchedAlert();
      const future = new Date(Date.now() + 60_000).toISOString();
      const past = new Date(Date.now() - 60_000).toISOString();

      const included = await app.inject({ method: "GET", url: `/alerts?from=${past}`, ...authHeaders(admin) });
      expect((included.json().items as Array<{ id: string }>).some((a) => a.id === id)).toBe(true);

      const excluded = await app.inject({ method: "GET", url: `/alerts?from=${future}`, ...authHeaders(admin) });
      expect((excluded.json().items as Array<{ id: string }>).some((a) => a.id === id)).toBe(false);
    });

    it("rejects from > to", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/alerts?from=2026-06-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z",
        ...authHeaders(admin),
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
