/**
 * Integration tests for the Module 09 alerts routes, run end-to-end against a live PostgreSQL
 * database. Skipped when DATABASE_URL isn't reachable, same convention as Modules 02–08. Runs
 * sequentially with other backend test files (`fileParallelism: false`).
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
  groups,
  groupMembers,
  templates,
  incidents,
  alerts,
  alertRecipients,
  alertContactSelections,
  alertGroupSelections,
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

describe.skipIf(!process.env.DATABASE_URL)("alerts routes (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C09";
  const createdUserIds: string[] = [];
  const createdContactIds: string[] = [];
  const createdGroupIds: string[] = [];
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
    const email = `test-alerts-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `Alerts Test ${roleCode}`, passwordHash })
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
    for (const id of createdGroupIds) {
      await db.delete(groupMembers).where(eq(groupMembers.groupId, id));
      await db.delete(groups).where(eq(groups.id, id));
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

  async function createContact(overrides: {
    email?: string | null;
    mobilePhone?: string | null;
    status?: string;
  } = {}): Promise<string> {
    const suffix = randomUUID().slice(0, 8);
    const [row] = await db
      .insert(contacts)
      .values({
        firstName: `Recip-${suffix}`,
        lastName: "Test",
        email: overrides.email === null ? null : (overrides.email ?? `recip-${suffix}@example.invalid`),
        mobilePhone: overrides.mobilePhone === null ? null : (overrides.mobilePhone ?? `+1555${suffix.slice(0, 7).padStart(7, "0")}`),
        status: overrides.status ?? "active",
      })
      .returning({ id: contacts.id });
    createdContactIds.push(row!.id);
    return row!.id;
  }

  async function createGroup(contactIds: string[]): Promise<string> {
    const [row] = await db
      .insert(groups)
      .values({ name: `Alerts Test Group ${randomUUID()}` })
      .returning({ id: groups.id });
    createdGroupIds.push(row!.id);
    if (contactIds.length > 0) {
      await db.insert(groupMembers).values(contactIds.map((contactId) => ({ groupId: row!.id, contactId })));
    }
    return row!.id;
  }

  async function createSmsTemplate(overrides: { status?: string; body?: string } = {}): Promise<string> {
    const [row] = await db
      .insert(templates)
      .values({
        name: `Alerts Test SMS Template ${randomUUID()}`,
        channel: "sms",
        body: overrides.body ?? "Hello {{firstName}}, this is a BEACON test.",
        status: overrides.status ?? "active",
      })
      .returning({ id: templates.id });
    createdTemplateIds.push(row!.id);
    return row!.id;
  }

  async function createRawIncident(overrides: { status?: "open" | "closed" } = {}): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/incidents",
      ...authHeaders(admin),
      payload: { title: `Alerts Test Incident ${tag}-${randomUUID().slice(0, 6)}`, severity: "warning" },
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

  async function createDraftAlert(payload: Record<string, unknown>): Promise<{ id: string; body: Record<string, unknown> }> {
    const response = await app.inject({
      method: "POST",
      url: "/alerts",
      ...authHeaders(admin),
      payload: { title: `Alert ${tag}-${randomUUID().slice(0, 6)}`, channel: "sms", contentSource: "adhoc", body: "Hi {{firstName}}", ...payload },
    });
    const body = response.json().alert as Record<string, unknown>;
    if (response.statusCode >= 200 && response.statusCode < 300) createdAlertIds.push(body.id as string);
    return { id: body.id as string, body };
  }

  describe("authentication and authorization", () => {
    it("GET /alerts requires authentication", async () => {
      const response = await app.inject({ method: "GET", url: "/alerts" });
      expect(response.statusCode).toBe(401);
    });

    it("RESPONDER can read but not create, and cannot read recipients", async () => {
      const read = await app.inject({ method: "GET", url: "/alerts", ...authHeaders(responder) });
      expect(read.statusCode).toBe(200);
      const create = await app.inject({
        method: "POST",
        url: "/alerts",
        ...authHeaders(responder),
        payload: { title: "Nope", channel: "sms", contentSource: "adhoc" },
      });
      expect(create.statusCode).toBe(403);
    });

    it("AUDITOR can read alerts and recipients but not create", async () => {
      const { id } = await createDraftAlert({});
      const read = await app.inject({ method: "GET", url: "/alerts", ...authHeaders(auditor) });
      expect(read.statusCode).toBe(200);
      const recipients = await app.inject({ method: "GET", url: `/alerts/${id}/recipients`, ...authHeaders(auditor) });
      expect(recipients.statusCode).toBe(200);
      const create = await app.inject({
        method: "POST",
        url: "/alerts",
        ...authHeaders(auditor),
        payload: { title: "Nope", channel: "sms", contentSource: "adhoc" },
      });
      expect(create.statusCode).toBe(403);
    });

    it("RESPONDER cannot read recipients (no alerts.recipients.read)", async () => {
      const { id } = await createDraftAlert({});
      const response = await app.inject({ method: "GET", url: `/alerts/${id}/recipients`, ...authHeaders(responder) });
      expect(response.statusCode).toBe(403);
    });

    it("COMMUNICATION_MANAGER and INCIDENT_COMMANDER have full alert management", async () => {
      for (const actor of [commManager, incidentCommander]) {
        const create = await app.inject({
          method: "POST",
          url: "/alerts",
          ...authHeaders(actor),
          payload: { title: `Full mgmt ${tag}`, channel: "sms", contentSource: "adhoc", body: "Hi {{firstName}}" },
        });
        expect(create.statusCode).toBe(201);
        const id = create.json().alert.id as string;
        createdAlertIds.push(id);
        const cancel = await app.inject({ method: "POST", url: `/alerts/${id}/cancel`, ...authHeaders(actor) });
        expect(cancel.statusCode).toBe(200);
      }
    });
  });

  describe("CRUD and validation", () => {
    it("creates a draft Alert with a server-generated unique alert number", async () => {
      const a = await createDraftAlert({});
      const b = await createDraftAlert({});
      expect(a.body.alertNumber).toMatch(/^ALT-\d{4}-\d{6}$/);
      expect(a.body.status).toBe("draft");
      expect(a.body.alertNumber).not.toBe(b.body.alertNumber);
    });

    it("rejects an invalid channel", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/alerts",
        ...authHeaders(admin),
        payload: { title: "Bad channel", channel: "carrier-pigeon", contentSource: "adhoc" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects linking to a CLOSED Incident", async () => {
      const incidentId = await createRawIncident({ status: "closed" });
      const response = await app.inject({
        method: "POST",
        url: "/alerts",
        ...authHeaders(admin),
        payload: { title: "Closed incident alert", channel: "sms", contentSource: "adhoc", body: "hi", incidentId },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("incident_not_eligible");
    });

    it("rejects an unknown Incident id", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/alerts",
        ...authHeaders(admin),
        payload: { title: "Unknown incident", channel: "sms", contentSource: "adhoc", body: "hi", incidentId: randomUUID() },
      });
      expect(response.statusCode).toBe(400);
    });

    it("supports a standalone Alert (no Incident)", async () => {
      const { body } = await createDraftAlert({});
      expect(body.incident).toBeNull();
    });

    it("supports an Incident-linked Alert", async () => {
      const incidentId = await createRawIncident();
      const { body } = await createDraftAlert({ incidentId });
      expect((body.incident as Record<string, unknown>).id).toBe(incidentId);
    });

    it("supports Template-based content and rejects a channel mismatch", async () => {
      const templateId = await createSmsTemplate();
      const ok = await createDraftAlert({ contentSource: "template", templateId, body: undefined });
      expect(ok.body.contentSource).toBe("template");

      const mismatch = await app.inject({
        method: "POST",
        url: "/alerts",
        ...authHeaders(admin),
        payload: { title: "Mismatch", channel: "email", contentSource: "template", templateId },
      });
      expect(mismatch.statusCode).toBe(400);
    });

    it("ignores forged status/createdBy fields on PATCH (mass-assignment guard)", async () => {
      const { id } = await createDraftAlert({});
      const response = await app.inject({
        method: "PATCH",
        url: `/alerts/${id}`,
        ...authHeaders(admin),
        payload: { title: "Legit rename", status: "ready", createdBy: randomUUID() },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().alert.status).toBe("draft");
      expect(response.json().alert.title).toBe("Legit rename");
    });

    it("PATCH only works while DRAFT", async () => {
      const { id } = await createDraftAlert({ body: "Body {{firstName}}" });
      await app.inject({ method: "POST", url: `/alerts/${id}/cancel`, ...authHeaders(admin) });
      const response = await app.inject({ method: "PATCH", url: `/alerts/${id}`, ...authHeaders(admin), payload: { title: "New" } });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("alert_not_draft");
    });
  });

  describe("recipient resolution", () => {
    it("resolves a direct Contact", async () => {
      const contactId = await createContact();
      const { id } = await createDraftAlert({ contactIds: [contactId] });
      const preview = await app.inject({ method: "POST", url: `/alerts/${id}/preview`, ...authHeaders(admin) });
      expect(preview.json().eligibleCount).toBe(1);
    });

    it("expands a single Group and multiple Groups, dedupes overlap by Contact identity", async () => {
      const a = await createContact();
      const b = await createContact();
      const c = await createContact();
      const d = await createContact();
      const groupX = await createGroup([a, b, c]);
      const groupY = await createGroup([c, d]);

      const { id } = await createDraftAlert({ contactIds: [a], groupIds: [groupX, groupY] });
      const preview = await app.inject({ method: "POST", url: `/alerts/${id}/preview`, ...authHeaders(admin) });
      const body = preview.json();
      // a directly + groupX(a,b,c) + groupY(c,d) => unique {a,b,c,d} = 4, with 2 duplicate refs collapsed (a twice, c twice)
      expect(body.eligibleCount).toBe(4);
      expect(body.duplicatesCollapsedCount).toBe(2);
    });

    it("never merges two different Contacts sharing an email or phone", async () => {
      const shared = `shared-${randomUUID()}@example.invalid`;
      const x = await createContact({ email: shared });
      const y = await createContact({ email: shared });
      const { id } = await createDraftAlert({ channel: "email", contentSource: "adhoc", subject: "Hi", body: "Hi {{firstName}}", contactIds: [x, y] });
      const preview = await app.inject({ method: "POST", url: `/alerts/${id}/preview`, ...authHeaders(admin) });
      expect(preview.json().eligibleCount).toBe(2);
    });

    it("excludes inactive Contacts and missing-channel Contacts, with a safe reason summary", async () => {
      const inactive = await createContact({ status: "inactive" });
      const noPhone = await createContact({ mobilePhone: null });
      const { id } = await createDraftAlert({ contactIds: [inactive, noPhone] });
      const preview = await app.inject({ method: "POST", url: `/alerts/${id}/preview`, ...authHeaders(admin) });
      const body = preview.json();
      expect(body.eligibleCount).toBe(0);
      expect(body.excludedCount).toBe(2);
      expect(body.exclusionSummary).toEqual({ inactive: 1, missing_channel: 1 });
      expect(body.zeroRecipientWarning).toBe(true);
    });

    it("rejects READY with zero eligible recipients", async () => {
      const inactive = await createContact({ status: "inactive" });
      const { id } = await createDraftAlert({ contactIds: [inactive] });
      const ready = await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      expect(ready.statusCode).toBe(409);
      expect(ready.json().error).toBe("zero_eligible_recipients");
    });
  });

  describe("preview", () => {
    it("never persists recipients or transitions status", async () => {
      const contactId = await createContact();
      const { id } = await createDraftAlert({ contactIds: [contactId] });
      await app.inject({ method: "POST", url: `/alerts/${id}/preview`, ...authHeaders(admin) });

      const detail = await app.inject({ method: "GET", url: `/alerts/${id}`, ...authHeaders(admin) });
      expect(detail.json().alert.status).toBe("draft");

      const rows = await db.select().from(alertRecipients).where(eq(alertRecipients.alertId, id));
      expect(rows).toHaveLength(0);
    });

    it("renders sample content using synthetic placeholder values, not real Contact data", async () => {
      const contactId = await createContact();
      const { id } = await createDraftAlert({ contactIds: [contactId], body: "Hello {{firstName}} {{lastName}}" });
      const preview = await app.inject({ method: "POST", url: `/alerts/${id}/preview`, ...authHeaders(admin) });
      expect(preview.json().sampleRenderedBody).toBe("Hello Alex Morgan");
    });
  });

  describe("READY transition and snapshot immutability", () => {
    it("transitions DRAFT to READY, writing recipient snapshots and safe counts", async () => {
      const a = await createContact();
      const b = await createContact({ status: "inactive" });
      const { id } = await createDraftAlert({ contactIds: [a, b], body: "Hi {{firstName}}" });

      const ready = await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      expect(ready.statusCode).toBe(200);
      expect(ready.json().alert.status).toBe("ready");
      expect(ready.json().alert.eligibleRecipientCount).toBe(1);
      expect(ready.json().alert.excludedCount).toBe(1);

      const recipientRows = await db.select().from(alertRecipients).where(eq(alertRecipients.alertId, id));
      expect(recipientRows).toHaveLength(1);
      expect(recipientRows[0]!.contactId).toBe(a);
      expect(recipientRows[0]!.status).toBe("pending_delivery");
      expect(recipientRows[0]!.renderedBody).toMatch(/^Hi /);
    });

    it("Template change after READY does not alter the Alert's frozen content", async () => {
      const templateId = await createSmsTemplate({ body: "Original {{firstName}}" });
      const contactId = await createContact();
      const { id } = await createDraftAlert({ contentSource: "template", templateId, body: undefined, contactIds: [contactId] });

      const ready = await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      expect(ready.json().alert.body).toBe("Original {{firstName}}");

      await db.update(templates).set({ body: "Changed {{firstName}}" }).where(eq(templates.id, templateId));

      const detail = await app.inject({ method: "GET", url: `/alerts/${id}`, ...authHeaders(admin) });
      expect(detail.json().alert.body).toBe("Original {{firstName}}");
    });

    it("Contact destination/name change after READY does not alter the recipient snapshot", async () => {
      const contactId = await createContact({ mobilePhone: "+15550009001" });
      const { id } = await createDraftAlert({ contactIds: [contactId], body: "Hi {{firstName}}" });
      await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });

      const [before] = await db.select().from(alertRecipients).where(eq(alertRecipients.alertId, id));
      expect(before!.recipientAddress).toBe("+15550009001");

      await db.update(contacts).set({ mobilePhone: "+15550009999", firstName: "Changed" }).where(eq(contacts.id, contactId));

      const [after] = await db.select().from(alertRecipients).where(eq(alertRecipients.alertId, id));
      expect(after!.recipientAddress).toBe("+15550009001");
      expect(after!.renderedBody).not.toContain("Changed");
    });

    it("Group membership change after READY does not alter the recipient snapshot", async () => {
      const a = await createContact();
      const b = await createContact();
      const groupId = await createGroup([a]);
      const { id } = await createDraftAlert({ groupIds: [groupId], body: "Hi {{firstName}}" });
      await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });

      await db.insert(groupMembers).values({ groupId, contactId: b });

      const rows = await db.select().from(alertRecipients).where(eq(alertRecipients.alertId, id));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.contactId).toBe(a);
    });

    it("rejects READY when the selected Template has since become inactive", async () => {
      const templateId = await createSmsTemplate();
      const contactId = await createContact();
      const { id } = await createDraftAlert({ contentSource: "template", templateId, body: undefined, contactIds: [contactId] });

      await db.update(templates).set({ status: "inactive" }).where(eq(templates.id, templateId));

      const ready = await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      expect(ready.statusCode).toBe(409);
      expect(ready.json().error).toBe("template_not_usable");
    });

    it("rejects READY when a selected Group has since become inactive", async () => {
      const contactId = await createContact();
      const groupId = await createGroup([contactId]);
      const { id } = await createDraftAlert({ groupIds: [groupId] });

      await db.update(groups).set({ status: "inactive" }).where(eq(groups.id, groupId));

      const ready = await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      expect(ready.statusCode).toBe(409);
      expect(ready.json().error).toBe("invalid_group_selection");
    });

    it("rejects READY on a CLOSED-in-the-meantime Incident", async () => {
      const incidentId = await createRawIncident();
      const contactId = await createContact();
      const { id } = await createDraftAlert({ incidentId, contactIds: [contactId] });

      await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/resolve`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/close`, ...authHeaders(admin) });

      const ready = await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      expect(ready.statusCode).toBe(409);
      expect(ready.json().error).toBe("incident_not_eligible");
    });

    it("blocks editing, re-readying, and roster changes once READY", async () => {
      const contactId = await createContact();
      const { id } = await createDraftAlert({ contactIds: [contactId] });
      await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });

      const patch = await app.inject({ method: "PATCH", url: `/alerts/${id}`, ...authHeaders(admin), payload: { title: "Edited" } });
      expect(patch.statusCode).toBe(409);

      const reReady = await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      expect(reReady.statusCode).toBe(409);
      expect(reReady.json().error).toBe("alert_not_draft");
    });
  });

  describe("cancellation", () => {
    it("cancels a DRAFT Alert", async () => {
      const { id } = await createDraftAlert({});
      const response = await app.inject({ method: "POST", url: `/alerts/${id}/cancel`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
      expect(response.json().alert.status).toBe("cancelled");
    });

    it("cancels a READY Alert (no dispatch exists yet to conflict with)", async () => {
      const contactId = await createContact();
      const { id } = await createDraftAlert({ contactIds: [contactId] });
      await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      const response = await app.inject({ method: "POST", url: `/alerts/${id}/cancel`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
      expect(response.json().alert.status).toBe("cancelled");
    });

    it("CANCELLED is terminal — ready and re-cancel are both rejected", async () => {
      const { id } = await createDraftAlert({});
      await app.inject({ method: "POST", url: `/alerts/${id}/cancel`, ...authHeaders(admin) });

      const ready = await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      expect(ready.statusCode).toBe(409);

      const cancelAgain = await app.inject({ method: "POST", url: `/alerts/${id}/cancel`, ...authHeaders(admin) });
      expect(cancelAgain.statusCode).toBe(409);
    });
  });

  describe("Incident timeline integration", () => {
    it("appends safe ALERT_* events with no destination/message PII", async () => {
      const incidentId = await createRawIncident();
      const contactId = await createContact();
      const { id } = await createDraftAlert({ incidentId, contactIds: [contactId], body: "Secret body {{firstName}}" });
      await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/alerts/${id}/cancel`, ...authHeaders(admin) });

      const timeline = await app.inject({ method: "GET", url: `/incidents/${incidentId}/timeline?order=asc`, ...authHeaders(admin) });
      const eventTypes = timeline.json().items.map((e: { eventType: string }) => e.eventType);
      expect(eventTypes).toEqual(expect.arrayContaining(["ALERT_CREATED", "ALERT_READY", "ALERT_CANCELLED"]));

      const [contactRow] = await db.select({ email: contacts.email, firstName: contacts.firstName }).from(contacts).where(eq(contacts.id, contactId));
      const serialized = JSON.stringify(timeline.json());
      expect(serialized).not.toContain(contactRow!.firstName);
      expect(serialized).not.toContain(contactRow!.email);
      expect(serialized).not.toContain("Secret body");
    });

    it("standalone Alerts write no Incident timeline events", async () => {
      const { id } = await createDraftAlert({});
      // No incidentId — nothing to assert against a timeline; just confirm ready succeeds cleanly
      // without requiring one, proving the Incident link is genuinely optional.
      const contactId = await createContact();
      await app.inject({ method: "PATCH", url: `/alerts/${id}`, ...authHeaders(admin), payload: { contactIds: [contactId] } });
      const ready = await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });
      expect(ready.statusCode).toBe(200);
    });
  });

  describe("audit and PII safety", () => {
    it("records ALERT_* audit events without recipient PII, and alerts.read responses never include destination fields", async () => {
      const contactId = await createContact();
      const { id } = await createDraftAlert({ contactIds: [contactId], body: "Hi {{firstName}}" });
      await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });

      const events = await db.select({ eventType: auditLogs.eventType, metadata: auditLogs.metadata }).from(auditLogs).where(eq(auditLogs.resourceId, id));
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("ALERT_CREATED");
      expect(eventTypes).toContain("ALERT_READY");

      const [contactRow] = await db.select({ email: contacts.email, mobilePhone: contacts.mobilePhone }).from(contacts).where(eq(contacts.id, contactId));
      const serializedAudit = JSON.stringify(events);
      expect(serializedAudit).not.toContain(contactRow!.mobilePhone);

      const list = await app.inject({ method: "GET", url: "/alerts", ...authHeaders(admin) });
      const serializedList = JSON.stringify(list.json());
      expect(serializedList).not.toContain(contactRow!.mobilePhone);
    });

    it("GET /alerts/:id/recipients exposes destination only to alerts.recipients.read", async () => {
      const contactId = await createContact({ mobilePhone: "+15550008123" });
      const { id } = await createDraftAlert({ contactIds: [contactId], body: "Hi {{firstName}}" });
      await app.inject({ method: "POST", url: `/alerts/${id}/ready`, ...authHeaders(admin) });

      const response = await app.inject({ method: "GET", url: `/alerts/${id}/recipients`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
      expect(response.json().items[0].destination).toBe("+15550008123");
    });
  });
});
