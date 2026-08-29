/**
 * Integration tests for the Module 04 contacts routes, run end-to-end against a live
 * PostgreSQL database. Skipped when DATABASE_URL isn't reachable, same convention as the
 * Module 02/03 suites. Runs sequentially with other backend test files (`fileParallelism:
 * false` in vitest.config.ts).
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, users, roles, userRoles, contacts, auditLogs, type Database } from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("contacts routes (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C04";
  const createdUserIds: string[] = [];
  const createdContactIds: string[] = [];

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode: string): Promise<{ token: string; csrf: string }> {
    const email = `test-contacts-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `Contacts Test ${roleCode}`, passwordHash })
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
  let responder: { token: string; csrf: string };

  beforeAll(async () => {
    admin = await createActor("ADMIN");
    commManager = await createActor("COMMUNICATION_MANAGER");
    auditor = await createActor("AUDITOR");
    responder = await createActor("RESPONDER");
  });

  afterAll(async () => {
    for (const id of createdContactIds) {
      await db.delete(contacts).where(eq(contacts.id, id));
      await db.delete(auditLogs).where(eq(auditLogs.resourceId, id));
    }
    for (const id of createdUserIds) {
      await db.delete(users).where(eq(users.id, id));
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
    }
    await app.close();
  });

  async function createRawContact(overrides: { email?: string; mobilePhone?: string; firstName?: string } = {}) {
    const response = await app.inject({
      method: "POST",
      url: "/contacts",
      ...authHeaders(admin),
      payload: {
        firstName: overrides.firstName ?? "Test",
        lastName: "Contact",
        ...(overrides.email ? { email: overrides.email } : {}),
        ...(overrides.mobilePhone ? { mobilePhone: overrides.mobilePhone } : {}),
      },
    });
    const id = response.json().contact.id as string;
    createdContactIds.push(id);
    return response;
  }

  describe("authentication and authorization", () => {
    it("GET /contacts requires authentication", async () => {
      const response = await app.inject({ method: "GET", url: "/contacts" });
      expect(response.statusCode).toBe(401);
    });

    it("RESPONDER is denied contact read access", async () => {
      const response = await app.inject({ method: "GET", url: "/contacts", ...authHeaders(responder) });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("not_authorized");
    });

    it("AUDITOR can read but not create contacts", async () => {
      const read = await app.inject({ method: "GET", url: "/contacts", ...authHeaders(auditor) });
      expect(read.statusCode).toBe(200);

      const create = await app.inject({
        method: "POST",
        url: "/contacts",
        ...authHeaders(auditor),
        payload: { firstName: "X", lastName: "Y" },
      });
      expect(create.statusCode).toBe(403);
    });

    it("COMMUNICATION_MANAGER can create/update but not disable", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/contacts",
        ...authHeaders(commManager),
        payload: { firstName: "Comm", lastName: "Manager Created" },
      });
      expect(create.statusCode).toBe(201);
      const id = create.json().contact.id as string;
      createdContactIds.push(id);

      const update = await app.inject({
        method: "PATCH",
        url: `/contacts/${id}`,
        ...authHeaders(commManager),
        payload: { department: "Operations" },
      });
      expect(update.statusCode).toBe(200);

      const disable = await app.inject({ method: "POST", url: `/contacts/${id}/disable`, ...authHeaders(commManager) });
      expect(disable.statusCode).toBe(403);
    });
  });

  describe("CRUD and normalization", () => {
    it("creates a contact and normalizes email/phone", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/contacts",
        ...authHeaders(admin),
        payload: {
          firstName: "Jane",
          lastName: "Responder",
          email: "  Jane.Responder@EXAMPLE.com  ",
          mobilePhone: "(415) 867-5309",
        },
      });
      expect(response.statusCode).toBe(201);
      const contact = response.json().contact;
      createdContactIds.push(contact.id);

      expect(contact.email).toBe("jane.responder@example.com");
      expect(contact.mobilePhone).toBe("+14158675309");
      expect(contact.displayName).toBe("Jane Responder");
    });

    it("rejects an invalid email", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/contacts",
        ...authHeaders(admin),
        payload: { firstName: "X", lastName: "Y", email: "not-an-email" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects an invalid phone number", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/contacts",
        ...authHeaders(admin),
        payload: { firstName: "X", lastName: "Y", mobilePhone: "123" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a missing required field", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/contacts",
        ...authHeaders(admin),
        payload: { firstName: "OnlyFirst" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a malformed UUID in the path", async () => {
      const response = await app.inject({ method: "GET", url: "/contacts/not-a-uuid", ...authHeaders(admin) });
      expect(response.statusCode).toBe(400);
    });

    it("returns 404 for a well-formed but unknown UUID", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/contacts/${randomUUID()}`,
        ...authHeaders(admin),
      });
      expect(response.statusCode).toBe(404);
    });

    it("gets and updates a contact", async () => {
      const created = await createRawContact();
      const id = created.json().contact.id;

      const get = await app.inject({ method: "GET", url: `/contacts/${id}`, ...authHeaders(admin) });
      expect(get.statusCode).toBe(200);

      const update = await app.inject({
        method: "PATCH",
        url: `/contacts/${id}`,
        ...authHeaders(admin),
        payload: { department: "IT Operations" },
      });
      expect(update.statusCode).toBe(200);
      expect(update.json().contact.department).toBe("IT Operations");
    });

    it("ignores unexpected fields on create (mass-assignment guard)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/contacts",
        ...authHeaders(admin),
        payload: { firstName: "X", lastName: "Y", status: "inactive", id: randomUUID() },
      });
      expect(response.statusCode).toBe(201);
      const contact = response.json().contact;
      createdContactIds.push(contact.id);
      expect(contact.status).toBe("active");
    });
  });

  describe("duplicate detection", () => {
    it("flags a likely duplicate by email and does not silently merge", async () => {
      const email = `test-dup-${randomUUID()}@example.invalid`;
      const first = await createRawContact({ email });

      const second = await app.inject({
        method: "POST",
        url: "/contacts",
        ...authHeaders(admin),
        payload: { firstName: "Different", lastName: "Person", email },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("likely_duplicate");
      expect(second.json().duplicates[0].id).toBe(first.json().contact.id);

      // Confirming creates a genuinely separate row — never an automatic merge.
      const confirmed = await app.inject({
        method: "POST",
        url: "/contacts",
        ...authHeaders(admin),
        payload: { firstName: "Different", lastName: "Person", email, confirmDuplicate: true },
      });
      expect(confirmed.statusCode).toBe(201);
      expect(confirmed.json().contact.id).not.toBe(first.json().contact.id);
      createdContactIds.push(confirmed.json().contact.id);
    });

    it("flags a likely duplicate by phone", async () => {
      const mobilePhone = "212-333-4455";
      const first = await createRawContact({ mobilePhone });

      const second = await app.inject({
        method: "POST",
        url: "/contacts",
        ...authHeaders(admin),
        payload: { firstName: "Another", lastName: "Person", mobilePhone },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().duplicates[0].id).toBe(first.json().contact.id);
    });

    it("shared email/phone across confirmed contacts does not violate a DB constraint", async () => {
      // Two contacts with the same confirmed-duplicate email must coexist without any unique-index error.
      const email = `test-shared-${randomUUID()}@example.invalid`;
      const a = await createRawContact({ email });
      const secondResponse = await app.inject({
        method: "POST",
        url: "/contacts",
        ...authHeaders(admin),
        payload: { firstName: "Shared", lastName: "Email", email, confirmDuplicate: true },
      });
      expect(secondResponse.statusCode).toBe(201);
      createdContactIds.push(secondResponse.json().contact.id);

      const rows = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.email, email));
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.id)).toContain(a.json().contact.id);
    });
  });

  describe("search, filter, and pagination", () => {
    it("searches by first name, email, and phone", async () => {
      const uniqueTag = randomUUID().slice(0, 8);
      const created = await createRawContact({
        firstName: `Searchable-${uniqueTag}`,
        email: `searchable-${uniqueTag}@example.invalid`,
      });
      const id = created.json().contact.id;

      const byName = await app.inject({
        method: "GET",
        url: `/contacts?search=Searchable-${uniqueTag}`,
        ...authHeaders(admin),
      });
      expect(byName.json().items.some((c: { id: string }) => c.id === id)).toBe(true);

      const byEmail = await app.inject({
        method: "GET",
        url: `/contacts?search=searchable-${uniqueTag}@example`,
        ...authHeaders(admin),
      });
      expect(byEmail.json().items.some((c: { id: string }) => c.id === id)).toBe(true);
    });

    it("filters by active status", async () => {
      const created = await createRawContact();
      const id = created.json().contact.id;
      await app.inject({ method: "POST", url: `/contacts/${id}/disable`, ...authHeaders(admin) });

      const activeOnly = await app.inject({ method: "GET", url: "/contacts?status=active", ...authHeaders(admin) });
      expect(activeOnly.json().items.some((c: { id: string }) => c.id === id)).toBe(false);

      const inactiveOnly = await app.inject({ method: "GET", url: "/contacts?status=inactive", ...authHeaders(admin) });
      expect(inactiveOnly.json().items.some((c: { id: string }) => c.id === id)).toBe(true);

      // re-enable so it doesn't skew other tests
      await app.inject({ method: "POST", url: `/contacts/${id}/enable`, ...authHeaders(admin) });
    });

    it("respects pagination shape", async () => {
      const response = await app.inject({ method: "GET", url: "/contacts?page=1&pageSize=2", ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(2);
      expect(body.items.length).toBeLessThanOrEqual(2);
    });
  });

  describe("lifecycle", () => {
    it("disabled contact remains retrievable by an authorized admin, and enabling restores active status", async () => {
      const created = await createRawContact();
      const id = created.json().contact.id;

      const disable = await app.inject({ method: "POST", url: `/contacts/${id}/disable`, ...authHeaders(admin) });
      expect(disable.statusCode).toBe(200);
      expect(disable.json().contact.status).toBe("inactive");

      const stillGettable = await app.inject({ method: "GET", url: `/contacts/${id}`, ...authHeaders(admin) });
      expect(stillGettable.statusCode).toBe(200);

      const enable = await app.inject({ method: "POST", url: `/contacts/${id}/enable`, ...authHeaders(admin) });
      expect(enable.statusCode).toBe(200);
      expect(enable.json().contact.status).toBe("active");
    });
  });

  describe("audit trail and response safety", () => {
    it("records CONTACT_CREATED/UPDATED/DISABLED/ENABLED without raw PII in metadata", async () => {
      const email = `test-audit-${randomUUID()}@example.invalid`;
      const created = await createRawContact({ email });
      const id = created.json().contact.id;

      await app.inject({
        method: "PATCH",
        url: `/contacts/${id}`,
        ...authHeaders(admin),
        payload: { department: "Finance" },
      });
      await app.inject({ method: "POST", url: `/contacts/${id}/disable`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/contacts/${id}/enable`, ...authHeaders(admin) });

      const events = await db
        .select({ eventType: auditLogs.eventType, metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, id));

      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("CONTACT_CREATED");
      expect(eventTypes).toContain("CONTACT_UPDATED");
      expect(eventTypes).toContain("CONTACT_DISABLED");
      expect(eventTypes).toContain("CONTACT_ENABLED");

      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(email);
    });

    it("contact responses never include authentication-related fields", async () => {
      const created = await createRawContact();
      const serialized = JSON.stringify(created.json());
      expect(serialized).not.toMatch(/passwordHash|argon2|mfa|sessionToken|recoveryCode/i);
    });
  });
});
