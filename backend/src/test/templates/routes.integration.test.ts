/**
 * Integration tests for the Module 07 templates routes, run end-to-end against a live
 * PostgreSQL database. Skipped when DATABASE_URL isn't reachable, same convention as Modules
 * 02–06. Runs sequentially with other backend test files (`fileParallelism: false`).
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, users, roles, userRoles, templates, auditLogs, type Database } from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("templates routes (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C07";
  const createdUserIds: string[] = [];
  const createdTemplateIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode: string): Promise<{ token: string; csrf: string }> {
    const email = `test-templates-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `Templates Test ${roleCode}`, passwordHash })
      .returning({ id: users.id });
    createdUserIds.push(row!.id);
    await db.insert(userRoles).values({ userId: row!.id, roleId: await roleId(roleCode) });

    const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: testPassword } });
    if (response.statusCode !== 200) {
      throw new Error(`login failed for ${roleCode}: ${response.statusCode} ${response.body}`);
    }
    return {
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

  let admin: { token: string; csrf: string };
  let commManager: { token: string; csrf: string };
  let auditor: { token: string; csrf: string };
  let incidentCommander: { token: string; csrf: string };
  let responder: { token: string; csrf: string };

  beforeAll(async () => {
    admin = await createActor("ADMIN");
    commManager = await createActor("COMMUNICATION_MANAGER");
    auditor = await createActor("AUDITOR");
    incidentCommander = await createActor("INCIDENT_COMMANDER");
    responder = await createActor("RESPONDER");
  });

  afterAll(async () => {
    for (const id of createdTemplateIds) {
      await db.delete(auditLogs).where(eq(auditLogs.resourceId, id));
      await db.delete(templates).where(eq(templates.id, id));
    }
    for (const id of createdUserIds) {
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
      await db.delete(users).where(eq(users.id, id));
    }
    await app.close();
  });

  async function createRawTemplate(overrides: {
    name?: string;
    channel?: "sms" | "email";
    subject?: string;
    body?: string;
  } = {}): Promise<{ id: string; response: unknown }> {
    const channel = overrides.channel ?? "sms";
    const payload: Record<string, string> = {
      name: overrides.name ?? `Template ${tag}-${randomUUID().slice(0, 6)}`,
      channel,
      body: overrides.body ?? "Hello {{firstName}}, this is a test.",
    };
    if (channel === "email") payload.subject = overrides.subject ?? "Test subject";
    const response = await app.inject({ method: "POST", url: "/templates", ...authHeaders(admin), payload });
    const id = response.json().template.id as string;
    createdTemplateIds.push(id);
    return { id, response: response.json() };
  }

  describe("authentication and authorization", () => {
    it("GET /templates requires authentication", async () => {
      const response = await app.inject({ method: "GET", url: "/templates" });
      expect(response.statusCode).toBe(401);
    });

    it("RESPONDER is denied all template access", async () => {
      const response = await app.inject({ method: "GET", url: "/templates", ...authHeaders(responder) });
      expect(response.statusCode).toBe(403);
    });

    it("AUDITOR can read but not create templates", async () => {
      const read = await app.inject({ method: "GET", url: "/templates", ...authHeaders(auditor) });
      expect(read.statusCode).toBe(200);

      const create = await app.inject({
        method: "POST",
        url: "/templates",
        ...authHeaders(auditor),
        payload: { name: `Auditor-${tag}`, channel: "sms", body: "x" },
      });
      expect(create.statusCode).toBe(403);
    });

    it("INCIDENT_COMMANDER can read but not create templates", async () => {
      const read = await app.inject({ method: "GET", url: "/templates", ...authHeaders(incidentCommander) });
      expect(read.statusCode).toBe(200);

      const create = await app.inject({
        method: "POST",
        url: "/templates",
        ...authHeaders(incidentCommander),
        payload: { name: `IC-${tag}`, channel: "sms", body: "x" },
      });
      expect(create.statusCode).toBe(403);
    });

    it("COMMUNICATION_MANAGER has full template management", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/templates",
        ...authHeaders(commManager),
        payload: { name: `CommMgr Template ${tag}`, channel: "sms", body: "Hello there." },
      });
      expect(create.statusCode).toBe(201);
      const id = create.json().template.id as string;
      createdTemplateIds.push(id);

      const update = await app.inject({
        method: "PATCH",
        url: `/templates/${id}`,
        ...authHeaders(commManager),
        payload: { body: "Updated body." },
      });
      expect(update.statusCode).toBe(200);

      const disable = await app.inject({ method: "POST", url: `/templates/${id}/disable`, ...authHeaders(commManager) });
      expect(disable.statusCode).toBe(200);
    });
  });

  describe("CRUD and validation", () => {
    it("creates an SMS template", async () => {
      const { response } = await createRawTemplate({ name: `SMS Create ${tag}`, channel: "sms", body: "Evacuate now." });
      const template = (response as { template: Record<string, unknown> }).template;
      expect(template.channel).toBe("sms");
      expect(template.subject).toBeNull();
      expect(template.status).toBe("active");
    });

    it("creates an Email template", async () => {
      const { response } = await createRawTemplate({
        name: `Email Create ${tag}`,
        channel: "email",
        subject: "Facility Closure",
        body: "Please review the attached notice.",
      });
      const template = (response as { template: Record<string, unknown> }).template;
      expect(template.channel).toBe("email");
      expect(template.subject).toBe("Facility Closure");
    });

    it("rejects an SMS template with a subject", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/templates",
        ...authHeaders(admin),
        payload: { name: `SMS Subject ${tag}`, channel: "sms", subject: "Not allowed", body: "x" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects an Email template with no subject", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/templates",
        ...authHeaders(admin),
        payload: { name: `Email NoSubject ${tag}`, channel: "email", body: "x" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a blank name", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/templates",
        ...authHeaders(admin),
        payload: { name: "   ", channel: "sms", body: "x" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects an invalid channel", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/templates",
        ...authHeaders(admin),
        payload: { name: `Invalid Channel ${tag}`, channel: "voice", body: "x" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a missing body", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/templates",
        ...authHeaders(admin),
        payload: { name: `No Body ${tag}`, channel: "sms" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a case-equivalent duplicate name on the same channel", async () => {
      const name = `Emergency Closure ${tag}`;
      await createRawTemplate({ name, channel: "sms" });

      const dup = await app.inject({
        method: "POST",
        url: "/templates",
        ...authHeaders(admin),
        payload: { name: name.toUpperCase(), channel: "sms", body: "x" },
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toBe("duplicate_template_name");
    });

    it("allows the same name to coexist across different channels", async () => {
      const name = `Cross Channel ${tag}`;
      await createRawTemplate({ name, channel: "sms" });

      const emailVersion = await app.inject({
        method: "POST",
        url: "/templates",
        ...authHeaders(admin),
        payload: { name, channel: "email", subject: "Same name, different channel", body: "x" },
      });
      expect(emailVersion.statusCode).toBe(201);
      createdTemplateIds.push(emailVersion.json().template.id);
    });

    it("rejects a malformed UUID in the path", async () => {
      const response = await app.inject({ method: "GET", url: "/templates/not-a-uuid", ...authHeaders(admin) });
      expect(response.statusCode).toBe(400);
    });

    it("returns 404 for a well-formed but unknown UUID", async () => {
      const response = await app.inject({ method: "GET", url: `/templates/${randomUUID()}`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(404);
    });

    it("lists, searches, and filters by channel and status", async () => {
      const uniqueTag = randomUUID().slice(0, 8);
      const { id } = await createRawTemplate({ name: `Findable-${uniqueTag}`, channel: "sms" });

      const bySearch = await app.inject({ method: "GET", url: `/templates?search=Findable-${uniqueTag}`, ...authHeaders(admin) });
      expect(bySearch.json().items.some((t: { id: string }) => t.id === id)).toBe(true);

      const byChannel = await app.inject({ method: "GET", url: `/templates?search=Findable-${uniqueTag}&channel=email`, ...authHeaders(admin) });
      expect(byChannel.json().items.some((t: { id: string }) => t.id === id)).toBe(false);

      await app.inject({ method: "POST", url: `/templates/${id}/disable`, ...authHeaders(admin) });
      const activeOnly = await app.inject({ method: "GET", url: `/templates?search=Findable-${uniqueTag}&status=active`, ...authHeaders(admin) });
      expect(activeOnly.json().items.some((t: { id: string }) => t.id === id)).toBe(false);
      const inactiveOnly = await app.inject({ method: "GET", url: `/templates?search=Findable-${uniqueTag}&status=inactive`, ...authHeaders(admin) });
      expect(inactiveOnly.json().items.some((t: { id: string }) => t.id === id)).toBe(true);
      await app.inject({ method: "POST", url: `/templates/${id}/enable`, ...authHeaders(admin) });
    });

    it("updates a template and ignores unexpected fields (mass-assignment guard)", async () => {
      const { id } = await createRawTemplate({ channel: "sms" });
      const response = await app.inject({
        method: "PATCH",
        url: `/templates/${id}`,
        ...authHeaders(admin),
        payload: { body: "Updated body text.", status: "inactive", channel: "email", id: randomUUID() },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().template.body).toBe("Updated body text.");
      expect(response.json().template.status).toBe("active");
      expect(response.json().template.channel).toBe("sms");
    });

    it("disables and re-enables a template", async () => {
      const { id } = await createRawTemplate();
      const disable = await app.inject({ method: "POST", url: `/templates/${id}/disable`, ...authHeaders(admin) });
      expect(disable.statusCode).toBe(200);
      expect(disable.json().template.status).toBe("inactive");

      const stillGettable = await app.inject({ method: "GET", url: `/templates/${id}`, ...authHeaders(admin) });
      expect(stillGettable.statusCode).toBe(200);

      const enable = await app.inject({ method: "POST", url: `/templates/${id}/enable`, ...authHeaders(admin) });
      expect(enable.statusCode).toBe(200);
      expect(enable.json().template.status).toBe("active");
    });
  });

  describe("placeholders", () => {
    it("accepts firstName, lastName, and displayName", async () => {
      const { response } = await createRawTemplate({
        name: `All Placeholders ${tag}`,
        channel: "sms",
        body: "Hi {{firstName}} {{lastName}} ({{displayName}}).",
      });
      const template = (response as { template: { placeholders: string[] } }).template;
      expect(template.placeholders.sort()).toEqual(["displayName", "firstName", "lastName"]);
    });

    it("rejects an unknown placeholder", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/templates",
        ...authHeaders(admin),
        payload: { name: `Unknown Placeholder ${tag}`, channel: "sms", body: "{{middleName}}" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a malformed placeholder", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/templates",
        ...authHeaders(admin),
        payload: { name: `Malformed Placeholder ${tag}`, channel: "sms", body: "{{user.password}}" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects expression/function-call syntax", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/templates",
        ...authHeaders(admin),
        payload: { name: `Expr Syntax ${tag}`, channel: "sms", body: "{{foo()}}" },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("preview", () => {
    it("previews ad-hoc SMS content with synthetic values and SMS segment guidance", async () => {
      const beforeCount = await db.select({ id: templates.id }).from(templates);

      const response = await app.inject({
        method: "POST",
        url: "/templates/preview",
        ...authHeaders(admin),
        payload: { channel: "sms", body: "Hello {{firstName}}, this is an emergency notification." },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.renderedBody).toBe("Hello Alex, this is an emergency notification.");
      expect(body.unresolvedPlaceholders).toEqual([]);
      expect(body.sms.encoding).toBe("GSM-7");
      expect(body.sms.segmentCount).toBe(1);

      const afterCount = await db.select({ id: templates.id }).from(templates);
      expect(afterCount.length).toBe(beforeCount.length);
    });

    it("previews an existing template by id", async () => {
      const { id } = await createRawTemplate({
        channel: "email",
        subject: "Update for {{firstName}}",
        body: "Dear {{displayName}}, please review.",
      });
      const response = await app.inject({ method: "POST", url: "/templates/preview", ...authHeaders(admin), payload: { templateId: id } });
      expect(response.statusCode).toBe(200);
      expect(response.json().renderedSubject).toBe("Update for Alex");
      expect(response.json().renderedBody).toBe("Dear Alex Morgan, please review.");
    });

    it("rejects unknown placeholders in ad-hoc preview content too", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/templates/preview",
        ...authHeaders(admin),
        payload: { channel: "sms", body: "{{ssn}}" },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("audit trail and response safety", () => {
    it("records TEMPLATE_CREATED/UPDATED/DISABLED/ENABLED without the message body in metadata", async () => {
      const secretBody = "SecretBodyMarker0007 evacuate the north wing immediately";
      const { id } = await createRawTemplate({ channel: "sms", body: secretBody });

      await app.inject({ method: "PATCH", url: `/templates/${id}`, ...authHeaders(admin), payload: { body: "Different body." } });
      await app.inject({ method: "POST", url: `/templates/${id}/disable`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/templates/${id}/enable`, ...authHeaders(admin) });

      const events = await db.select({ eventType: auditLogs.eventType, metadata: auditLogs.metadata }).from(auditLogs).where(eq(auditLogs.resourceId, id));
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("TEMPLATE_CREATED");
      expect(eventTypes).toContain("TEMPLATE_UPDATED");
      expect(eventTypes).toContain("TEMPLATE_DISABLED");
      expect(eventTypes).toContain("TEMPLATE_ENABLED");

      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("SecretBodyMarker0007");
      expect(serialized).not.toContain("Different body.");
    });

    it("template responses never include authentication-related fields", async () => {
      const { response } = await createRawTemplate();
      const serialized = JSON.stringify(response);
      expect(serialized).not.toMatch(/passwordHash|argon2|mfa|sessionToken|recoveryCode/i);
    });

    it("stores and returns an XSS-shaped payload verbatim as inert text, never executed server-side", async () => {
      const payload = '<script>alert("xss")</script>';
      const { response } = await createRawTemplate({ channel: "sms", body: payload });
      const template = (response as { template: { body: string } }).template;
      expect(template.body).toBe(payload);
    });
  });
});
