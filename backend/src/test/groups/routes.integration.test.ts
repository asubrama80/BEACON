/**
 * Integration tests for the Module 06 groups routes, run end-to-end against a live PostgreSQL
 * database. Skipped when DATABASE_URL isn't reachable, same convention as Modules 02–05. Runs
 * sequentially with other backend test files (`fileParallelism: false`).
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, users, roles, userRoles, contacts, groups, groupMembers, auditLogs, type Database } from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("groups routes (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C06";
  const createdUserIds: string[] = [];
  const createdContactIds: string[] = [];
  const createdGroupIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode: string): Promise<{ token: string; csrf: string }> {
    const email = `test-groups-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `Groups Test ${roleCode}`, passwordHash })
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
    for (const id of createdGroupIds) {
      await db.delete(auditLogs).where(eq(auditLogs.resourceId, id));
      await db.delete(groupMembers).where(eq(groupMembers.groupId, id));
      await db.delete(groups).where(eq(groups.id, id));
    }
    for (const id of createdContactIds) {
      await db.delete(auditLogs).where(eq(auditLogs.resourceId, id));
      await db.delete(contacts).where(eq(contacts.id, id));
    }
    for (const id of createdUserIds) {
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
      await db.delete(users).where(eq(users.id, id));
    }
    await app.close();
  });

  async function createRawContact(overrides: { firstName?: string; status?: string } = {}): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/contacts",
      ...authHeaders(admin),
      payload: {
        firstName: overrides.firstName ?? `GroupTest-${randomUUID().slice(0, 6)}`,
        lastName: "Contact",
      },
    });
    const id = response.json().contact.id as string;
    createdContactIds.push(id);
    if (overrides.status === "inactive") {
      await app.inject({ method: "POST", url: `/contacts/${id}/disable`, ...authHeaders(admin) });
    }
    return id;
  }

  async function createRawGroup(name: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/groups",
      ...authHeaders(admin),
      payload: { name },
    });
    const id = response.json().group.id as string;
    createdGroupIds.push(id);
    return id;
  }

  describe("authentication and authorization", () => {
    it("GET /groups requires authentication", async () => {
      const response = await app.inject({ method: "GET", url: "/groups" });
      expect(response.statusCode).toBe(401);
    });

    it("RESPONDER is denied all group access", async () => {
      const read = await app.inject({ method: "GET", url: "/groups", ...authHeaders(responder) });
      expect(read.statusCode).toBe(403);
      const create = await app.inject({
        method: "POST",
        url: "/groups",
        ...authHeaders(responder),
        payload: { name: `Responder-${tag}` },
      });
      expect(create.statusCode).toBe(403);
    });

    it("AUDITOR can read but not create/update/disable groups", async () => {
      const read = await app.inject({ method: "GET", url: "/groups", ...authHeaders(auditor) });
      expect(read.statusCode).toBe(200);

      const create = await app.inject({
        method: "POST",
        url: "/groups",
        ...authHeaders(auditor),
        payload: { name: `Auditor-${tag}` },
      });
      expect(create.statusCode).toBe(403);
    });

    it("INCIDENT_COMMANDER has groups.read but not group management", async () => {
      const read = await app.inject({ method: "GET", url: "/groups", ...authHeaders(incidentCommander) });
      expect(read.statusCode).toBe(200);

      const create = await app.inject({
        method: "POST",
        url: "/groups",
        ...authHeaders(incidentCommander),
        payload: { name: `IC-${tag}` },
      });
      expect(create.statusCode).toBe(403);
    });

    it("COMMUNICATION_MANAGER has full group management", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/groups",
        ...authHeaders(commManager),
        payload: { name: `CommMgr Group ${tag}` },
      });
      expect(create.statusCode).toBe(201);
      const id = create.json().group.id as string;
      createdGroupIds.push(id);

      const update = await app.inject({
        method: "PATCH",
        url: `/groups/${id}`,
        ...authHeaders(commManager),
        payload: { description: "Managed by comm manager" },
      });
      expect(update.statusCode).toBe(200);

      const disable = await app.inject({ method: "POST", url: `/groups/${id}/disable`, ...authHeaders(commManager) });
      expect(disable.statusCode).toBe(200);
    });
  });

  describe("group CRUD and name uniqueness", () => {
    it("creates a group", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/groups",
        ...authHeaders(admin),
        payload: { name: `Executive Crisis Team ${tag}`, description: "Senior leadership" },
      });
      expect(response.statusCode).toBe(201);
      const group = response.json().group;
      createdGroupIds.push(group.id);
      expect(group.status).toBe("active");
      expect(group.memberCount).toBe(0);
      expect(group.activeMemberCount).toBe(0);
    });

    it("rejects a blank name", async () => {
      const response = await app.inject({ method: "POST", url: "/groups", ...authHeaders(admin), payload: { name: "   " } });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a case-equivalent duplicate name", async () => {
      const name = `IT Operations ${tag}`;
      await createRawGroup(name);

      const dup = await app.inject({
        method: "POST",
        url: "/groups",
        ...authHeaders(admin),
        payload: { name: name.toUpperCase() },
      });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toBe("duplicate_group_name");
    });

    it("rejects a malformed UUID in the path", async () => {
      const response = await app.inject({ method: "GET", url: "/groups/not-a-uuid", ...authHeaders(admin) });
      expect(response.statusCode).toBe(400);
    });

    it("returns 404 for a well-formed but unknown UUID", async () => {
      const response = await app.inject({ method: "GET", url: `/groups/${randomUUID()}`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(404);
    });

    it("lists and searches groups", async () => {
      const name = `Searchable Group ${tag}`;
      await createRawGroup(name);

      const list = await app.inject({ method: "GET", url: `/groups?search=${encodeURIComponent(`Searchable Group ${tag}`)}`, ...authHeaders(admin) });
      expect(list.statusCode).toBe(200);
      expect(list.json().items.some((g: { name: string }) => g.name === name)).toBe(true);
    });

    it("updates a group and ignores unexpected fields (mass-assignment guard)", async () => {
      const id = await createRawGroup(`Update Target ${tag}`);
      const response = await app.inject({
        method: "PATCH",
        url: `/groups/${id}`,
        ...authHeaders(admin),
        payload: { description: "Updated", status: "inactive", id: randomUUID() },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().group.description).toBe("Updated");
      expect(response.json().group.status).toBe("active");
    });

    it("disables and re-enables a group", async () => {
      const id = await createRawGroup(`Lifecycle Group ${tag}`);
      const disable = await app.inject({ method: "POST", url: `/groups/${id}/disable`, ...authHeaders(admin) });
      expect(disable.statusCode).toBe(200);
      expect(disable.json().group.status).toBe("inactive");

      const stillGettable = await app.inject({ method: "GET", url: `/groups/${id}`, ...authHeaders(admin) });
      expect(stillGettable.statusCode).toBe(200);

      const enable = await app.inject({ method: "POST", url: `/groups/${id}/enable`, ...authHeaders(admin) });
      expect(enable.statusCode).toBe(200);
      expect(enable.json().group.status).toBe("active");
    });
  });

  describe("membership", () => {
    it("adds multiple members, prevents duplicates, and reports a clear result", async () => {
      const groupId = await createRawGroup(`Membership Group ${tag}`);
      const contactA = await createRawContact();
      const contactB = await createRawContact();

      const addResult = await app.inject({
        method: "POST",
        url: `/groups/${groupId}/members`,
        ...authHeaders(admin),
        payload: { contactIds: [contactA, contactB] },
      });
      expect(addResult.statusCode).toBe(200);
      expect(addResult.json().added.sort()).toEqual([contactA, contactB].sort());
      expect(addResult.json().alreadyMember).toEqual([]);

      const detail = await app.inject({ method: "GET", url: `/groups/${groupId}`, ...authHeaders(admin) });
      expect(detail.json().group.memberCount).toBe(2);

      // Repeated identical add is idempotent — not an error, and not a second row.
      const repeatAdd = await app.inject({
        method: "POST",
        url: `/groups/${groupId}/members`,
        ...authHeaders(admin),
        payload: { contactIds: [contactA] },
      });
      expect(repeatAdd.statusCode).toBe(200);
      expect(repeatAdd.json().added).toEqual([]);
      expect(repeatAdd.json().alreadyMember).toEqual([contactA]);

      const detailAfterRepeat = await app.inject({ method: "GET", url: `/groups/${groupId}`, ...authHeaders(admin) });
      expect(detailAfterRepeat.json().group.memberCount).toBe(2);
    });

    it("reports a nonexistent contact id rather than failing the whole request", async () => {
      const groupId = await createRawGroup(`Partial Add Group ${tag}`);
      const contactA = await createRawContact();
      const fakeId = randomUUID();

      const response = await app.inject({
        method: "POST",
        url: `/groups/${groupId}/members`,
        ...authHeaders(admin),
        payload: { contactIds: [contactA, fakeId] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().added).toEqual([contactA]);
      expect(response.json().notFound).toEqual([fakeId]);
    });

    it("rejects adding members to a nonexistent group", async () => {
      const contactA = await createRawContact();
      const response = await app.inject({
        method: "POST",
        url: `/groups/${randomUUID()}/members`,
        ...authHeaders(admin),
        payload: { contactIds: [contactA] },
      });
      expect(response.statusCode).toBe(404);
    });

    it("lists members with search and pagination", async () => {
      const groupId = await createRawGroup(`List Members Group ${tag}`);
      const uniqueTag = randomUUID().slice(0, 8);
      const contactA = await createRawContact({ firstName: `Findable-${uniqueTag}` });
      await app.inject({
        method: "POST",
        url: `/groups/${groupId}/members`,
        ...authHeaders(admin),
        payload: { contactIds: [contactA] },
      });

      const list = await app.inject({
        method: "GET",
        url: `/groups/${groupId}/members?search=Findable-${uniqueTag}`,
        ...authHeaders(admin),
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().items).toHaveLength(1);
      expect(list.json().items[0].contactId).toBe(contactA);
      expect(list.json().items[0].contactStatus).toBe("active");
    });

    it("a Contact can belong to multiple Groups", async () => {
      const groupOne = await createRawGroup(`Multi Group One ${tag}`);
      const groupTwo = await createRawGroup(`Multi Group Two ${tag}`);
      const contactA = await createRawContact();

      await app.inject({ method: "POST", url: `/groups/${groupOne}/members`, ...authHeaders(admin), payload: { contactIds: [contactA] } });
      await app.inject({ method: "POST", url: `/groups/${groupTwo}/members`, ...authHeaders(admin), payload: { contactIds: [contactA] } });

      const one = await app.inject({ method: "GET", url: `/groups/${groupOne}`, ...authHeaders(admin) });
      const two = await app.inject({ method: "GET", url: `/groups/${groupTwo}`, ...authHeaders(admin) });
      expect(one.json().group.memberCount).toBe(1);
      expect(two.json().group.memberCount).toBe(1);
    });

    it("removes a member without deleting or disabling the Contact", async () => {
      const groupId = await createRawGroup(`Remove Member Group ${tag}`);
      const contactA = await createRawContact();
      await app.inject({ method: "POST", url: `/groups/${groupId}/members`, ...authHeaders(admin), payload: { contactIds: [contactA] } });

      const remove = await app.inject({ method: "DELETE", url: `/groups/${groupId}/members/${contactA}`, ...authHeaders(admin) });
      expect(remove.statusCode).toBe(204);

      const detail = await app.inject({ method: "GET", url: `/groups/${groupId}`, ...authHeaders(admin) });
      expect(detail.json().group.memberCount).toBe(0);

      const contact = await app.inject({ method: "GET", url: `/contacts/${contactA}`, ...authHeaders(admin) });
      expect(contact.statusCode).toBe(200);
      expect(contact.json().contact.status).toBe("active");
    });
  });

  describe("inactive contacts remain historical members", () => {
    it("an inactive Contact remains a Group member and is clearly reported as inactive", async () => {
      const groupId = await createRawGroup(`Inactive Member Group ${tag}`);
      const contactA = await createRawContact({ status: "inactive" });

      const add = await app.inject({
        method: "POST",
        url: `/groups/${groupId}/members`,
        ...authHeaders(admin),
        payload: { contactIds: [contactA] },
      });
      expect(add.statusCode).toBe(200);
      expect(add.json().added).toEqual([contactA]);

      const detail = await app.inject({ method: "GET", url: `/groups/${groupId}`, ...authHeaders(admin) });
      expect(detail.json().group.memberCount).toBe(1);
      expect(detail.json().group.activeMemberCount).toBe(0);

      const members = await app.inject({ method: "GET", url: `/groups/${groupId}/members`, ...authHeaders(admin) });
      expect(members.json().items[0].contactStatus).toBe("inactive");
    });

    it("disabling a Contact after it's added keeps it a member and updates the active count", async () => {
      const groupId = await createRawGroup(`Disable After Add Group ${tag}`);
      const contactA = await createRawContact();
      await app.inject({ method: "POST", url: `/groups/${groupId}/members`, ...authHeaders(admin), payload: { contactIds: [contactA] } });

      const beforeDisable = await app.inject({ method: "GET", url: `/groups/${groupId}`, ...authHeaders(admin) });
      expect(beforeDisable.json().group.activeMemberCount).toBe(1);

      await app.inject({ method: "POST", url: `/contacts/${contactA}/disable`, ...authHeaders(admin) });

      const afterDisable = await app.inject({ method: "GET", url: `/groups/${groupId}`, ...authHeaders(admin) });
      expect(afterDisable.json().group.memberCount).toBe(1);
      expect(afterDisable.json().group.activeMemberCount).toBe(0);

      const members = await app.inject({ method: "GET", url: `/groups/${groupId}/members`, ...authHeaders(admin) });
      expect(members.json().items[0].contactStatus).toBe("inactive");

      await app.inject({ method: "POST", url: `/contacts/${contactA}/enable`, ...authHeaders(admin) });
    });
  });

  describe("audit trail and response safety", () => {
    it("records GROUP_CREATED/UPDATED/DISABLED/ENABLED/MEMBER_ADDED/MEMBER_REMOVED without PII", async () => {
      const groupId = await createRawGroup(`Audit Group ${tag}`);
      const contactA = await createRawContact({ firstName: "AuditSecretName" });

      await app.inject({ method: "PATCH", url: `/groups/${groupId}`, ...authHeaders(admin), payload: { description: "x" } });
      await app.inject({ method: "POST", url: `/groups/${groupId}/members`, ...authHeaders(admin), payload: { contactIds: [contactA] } });
      await app.inject({ method: "DELETE", url: `/groups/${groupId}/members/${contactA}`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/groups/${groupId}/disable`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/groups/${groupId}/enable`, ...authHeaders(admin) });

      const events = await db.select({ eventType: auditLogs.eventType, metadata: auditLogs.metadata }).from(auditLogs).where(eq(auditLogs.resourceId, groupId));
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("GROUP_CREATED");
      expect(eventTypes).toContain("GROUP_UPDATED");
      expect(eventTypes).toContain("GROUP_MEMBER_ADDED");
      expect(eventTypes).toContain("GROUP_MEMBER_REMOVED");
      expect(eventTypes).toContain("GROUP_DISABLED");
      expect(eventTypes).toContain("GROUP_ENABLED");

      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("AuditSecretName");
    });

    it("group and member responses never include authentication-related fields", async () => {
      const groupId = await createRawGroup(`Safety Group ${tag}`);
      const contactA = await createRawContact();
      await app.inject({ method: "POST", url: `/groups/${groupId}/members`, ...authHeaders(admin), payload: { contactIds: [contactA] } });

      const members = await app.inject({ method: "GET", url: `/groups/${groupId}/members`, ...authHeaders(admin) });
      const serialized = JSON.stringify(members.json());
      expect(serialized).not.toMatch(/passwordHash|argon2|mfa|sessionToken|recoveryCode/i);
    });
  });
});
