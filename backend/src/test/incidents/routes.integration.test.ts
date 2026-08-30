/**
 * Integration tests for the Module 08 incidents routes, run end-to-end against a live
 * PostgreSQL database. Skipped when DATABASE_URL isn't reachable, same convention as Modules
 * 02–07. Runs sequentially with other backend test files (`fileParallelism: false`).
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
  incidentParticipants,
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

describe.skipIf(!process.env.DATABASE_URL)("incidents routes (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C08";
  const createdUserIds: string[] = [];
  const createdContactIds: string[] = [];
  const createdIncidentIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode: string): Promise<{ id: string; token: string; csrf: string }> {
    const email = `test-incidents-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `Incidents Test ${roleCode}`, passwordHash })
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

  /** A plain, no-login-needed User row for use as a commander/participant target — not an actor. */
  async function createTargetUser(overrides: { status?: string } = {}): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `test-target-${randomUUID()}@example.invalid`,
        displayName: `Target User ${tag}`,
        passwordHash: "unused-in-this-test",
        status: overrides.status ?? "active",
      })
      .returning({ id: users.id });
    createdUserIds.push(row!.id);
    return row!.id;
  }

  async function createTargetContact(overrides: { status?: string } = {}): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/contacts",
      ...authHeaders(admin),
      payload: { firstName: `Target-${randomUUID().slice(0, 6)}`, lastName: "Contact" },
    });
    const id = response.json().contact.id as string;
    createdContactIds.push(id);
    if (overrides.status === "inactive") {
      await app.inject({ method: "POST", url: `/contacts/${id}/disable`, ...authHeaders(admin) });
    }
    return id;
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
    for (const id of createdIncidentIds) {
      await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
      await db.delete(incidentTimelineEvents).where(eq(incidentTimelineEvents.incidentId, id));
      await db.delete(incidentParticipants).where(eq(incidentParticipants.incidentId, id));
      await db.delete(incidents).where(eq(incidents.id, id));
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

  async function createRawIncident(overrides: { title?: string; severity?: string } = {}): Promise<{
    id: string;
    body: Record<string, unknown>;
  }> {
    const response = await app.inject({
      method: "POST",
      url: "/incidents",
      ...authHeaders(admin),
      payload: { title: overrides.title ?? `Incident ${tag}-${randomUUID().slice(0, 6)}`, severity: overrides.severity ?? "warning" },
    });
    const body = response.json().incident as Record<string, unknown>;
    createdIncidentIds.push(body.id as string);
    return { id: body.id as string, body };
  }

  describe("authentication and authorization", () => {
    it("GET /incidents requires authentication", async () => {
      const response = await app.inject({ method: "GET", url: "/incidents" });
      expect(response.statusCode).toBe(401);
    });

    it("RESPONDER can read but not create/manage", async () => {
      const read = await app.inject({ method: "GET", url: "/incidents", ...authHeaders(responder) });
      expect(read.statusCode).toBe(200);
      const create = await app.inject({
        method: "POST",
        url: "/incidents",
        ...authHeaders(responder),
        payload: { title: `Responder-${tag}`, severity: "info" },
      });
      expect(create.statusCode).toBe(403);
    });

    it("AUDITOR can read/timeline but not create/manage", async () => {
      const read = await app.inject({ method: "GET", url: "/incidents", ...authHeaders(auditor) });
      expect(read.statusCode).toBe(200);
      const create = await app.inject({
        method: "POST",
        url: "/incidents",
        ...authHeaders(auditor),
        payload: { title: `Auditor-${tag}`, severity: "info" },
      });
      expect(create.statusCode).toBe(403);
    });

    it("COMMUNICATION_MANAGER can create and read but not manage lifecycle/participants/commander", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/incidents",
        ...authHeaders(commManager),
        payload: { title: `CommMgr Incident ${tag}`, severity: "info" },
      });
      expect(create.statusCode).toBe(201);
      const id = create.json().incident.id as string;
      createdIncidentIds.push(id);

      const activate = await app.inject({ method: "POST", url: `/incidents/${id}/activate`, ...authHeaders(commManager) });
      expect(activate.statusCode).toBe(403);

      const commander = await app.inject({
        method: "POST",
        url: `/incidents/${id}/commander`,
        ...authHeaders(commManager),
        payload: { userId: admin.id },
      });
      expect(commander.statusCode).toBe(403);
    });

    it("INCIDENT_COMMANDER has full incident management", async () => {
      const create = await app.inject({
        method: "POST",
        url: "/incidents",
        ...authHeaders(incidentCommander),
        payload: { title: `IC Incident ${tag}`, severity: "high" },
      });
      expect(create.statusCode).toBe(201);
      const id = create.json().incident.id as string;
      createdIncidentIds.push(id);

      const activate = await app.inject({ method: "POST", url: `/incidents/${id}/activate`, ...authHeaders(incidentCommander) });
      expect(activate.statusCode).toBe(200);
    });
  });

  describe("CRUD and validation", () => {
    it("creates an Incident with a server-generated unique incident number", async () => {
      const { body } = await createRawIncident();
      expect(body.incidentNumber).toMatch(/^INC-\d{4}-\d{6}$/);
      expect(body.status).toBe("open");
    });

    it("generates distinct incident numbers under back-to-back creates", async () => {
      const a = await createRawIncident();
      const b = await createRawIncident();
      expect(a.body.incidentNumber).not.toBe(b.body.incidentNumber);
    });

    it("rejects an invalid severity", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/incidents",
        ...authHeaders(admin),
        payload: { title: `Bad Severity ${tag}`, severity: "extreme" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a blank title", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/incidents",
        ...authHeaders(admin),
        payload: { title: "   ", severity: "info" },
      });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a malformed UUID in the path", async () => {
      const response = await app.inject({ method: "GET", url: "/incidents/not-a-uuid", ...authHeaders(admin) });
      expect(response.statusCode).toBe(400);
    });

    it("returns 404 for a well-formed but unknown UUID", async () => {
      const response = await app.inject({ method: "GET", url: `/incidents/${randomUUID()}`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(404);
    });

    it("lists, searches by number and title, and filters by status/severity", async () => {
      const { id, body } = await createRawIncident({ title: `Findable Incident ${tag}` });

      const byTitle = await app.inject({ method: "GET", url: `/incidents?search=${encodeURIComponent(`Findable Incident ${tag}`)}`, ...authHeaders(admin) });
      expect(byTitle.json().items.some((i: { id: string }) => i.id === id)).toBe(true);

      const byNumber = await app.inject({ method: "GET", url: `/incidents?search=${body.incidentNumber}`, ...authHeaders(admin) });
      expect(byNumber.json().items.some((i: { id: string }) => i.id === id)).toBe(true);

      const byStatus = await app.inject({ method: "GET", url: "/incidents?status=open&severity=warning", ...authHeaders(admin) });
      expect(byStatus.json().items.some((i: { id: string }) => i.id === id)).toBe(true);

      const wrongSeverity = await app.inject({ method: "GET", url: "/incidents?severity=critical", ...authHeaders(admin) });
      expect(wrongSeverity.json().items.some((i: { id: string }) => i.id === id)).toBe(false);
    });

    it("updates title/description and ignores unexpected fields (mass-assignment guard)", async () => {
      const { id } = await createRawIncident();
      const response = await app.inject({
        method: "PATCH",
        url: `/incidents/${id}`,
        ...authHeaders(admin),
        payload: { description: "Updated description.", status: "closed", incidentCommanderId: admin.id, id: randomUUID() },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().incident.description).toBe("Updated description.");
      expect(response.json().incident.status).toBe("open");
    });

    it("changes severity and reports the prior value in the timeline", async () => {
      const { id } = await createRawIncident({ severity: "info" });
      const update = await app.inject({
        method: "PATCH",
        url: `/incidents/${id}`,
        ...authHeaders(admin),
        payload: { severity: "critical" },
      });
      expect(update.json().incident.severity).toBe("critical");

      const timeline = await app.inject({ method: "GET", url: `/incidents/${id}/timeline`, ...authHeaders(admin) });
      const event = timeline.json().items.find((e: { eventType: string }) => e.eventType === "SEVERITY_CHANGED");
      expect(event.metadata).toEqual({ from: "info", to: "critical" });
    });
  });

  describe("lifecycle", () => {
    it("walks OPEN → ACTIVE → RESOLVED → CLOSED", async () => {
      const { id } = await createRawIncident();
      const activate = await app.inject({ method: "POST", url: `/incidents/${id}/activate`, ...authHeaders(admin) });
      expect(activate.statusCode).toBe(200);
      expect(activate.json().incident.status).toBe("active");

      const resolve = await app.inject({ method: "POST", url: `/incidents/${id}/resolve`, ...authHeaders(admin) });
      expect(resolve.statusCode).toBe(200);
      expect(resolve.json().incident.status).toBe("resolved");

      const close = await app.inject({ method: "POST", url: `/incidents/${id}/close`, ...authHeaders(admin) });
      expect(close.statusCode).toBe(200);
      expect(close.json().incident.status).toBe("closed");
    });

    it("rejects an invalid transition (OPEN → RESOLVED directly)", async () => {
      const { id } = await createRawIncident();
      const response = await app.inject({ method: "POST", url: `/incidents/${id}/resolve`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("invalid_transition");
    });

    it("rejects a repeated (stale/concurrent-style) transition", async () => {
      const { id } = await createRawIncident();
      await app.inject({ method: "POST", url: `/incidents/${id}/activate`, ...authHeaders(admin) });
      const first = await app.inject({ method: "POST", url: `/incidents/${id}/resolve`, ...authHeaders(admin) });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: "POST", url: `/incidents/${id}/resolve`, ...authHeaders(admin) });
      expect(second.statusCode).toBe(409);
    });

    it("supports RESOLVED → ACTIVE reopen, but never allows CLOSED to reopen", async () => {
      const { id } = await createRawIncident();
      await app.inject({ method: "POST", url: `/incidents/${id}/activate`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${id}/resolve`, ...authHeaders(admin) });

      const reopen = await app.inject({ method: "POST", url: `/incidents/${id}/reopen`, ...authHeaders(admin) });
      expect(reopen.statusCode).toBe(200);
      expect(reopen.json().incident.status).toBe("active");

      await app.inject({ method: "POST", url: `/incidents/${id}/resolve`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${id}/close`, ...authHeaders(admin) });
      const reopenClosed = await app.inject({ method: "POST", url: `/incidents/${id}/reopen`, ...authHeaders(admin) });
      expect(reopenClosed.statusCode).toBe(409);
    });

    describe("CLOSED immutability", () => {
      async function createClosedIncident(): Promise<string> {
        const { id } = await createRawIncident();
        await app.inject({ method: "POST", url: `/incidents/${id}/activate`, ...authHeaders(admin) });
        await app.inject({ method: "POST", url: `/incidents/${id}/resolve`, ...authHeaders(admin) });
        await app.inject({ method: "POST", url: `/incidents/${id}/close`, ...authHeaders(admin) });
        return id;
      }

      it("rejects metadata update", async () => {
        const id = await createClosedIncident();
        const response = await app.inject({ method: "PATCH", url: `/incidents/${id}`, ...authHeaders(admin), payload: { title: "New Title" } });
        expect(response.statusCode).toBe(409);
        expect(response.json().error).toBe("incident_closed");
      });

      it("rejects commander change", async () => {
        const id = await createClosedIncident();
        const userId = await createTargetUser();
        const response = await app.inject({ method: "POST", url: `/incidents/${id}/commander`, ...authHeaders(admin), payload: { userId } });
        expect(response.statusCode).toBe(409);
      });

      it("rejects participant add", async () => {
        const id = await createClosedIncident();
        const userId = await createTargetUser();
        const response = await app.inject({ method: "POST", url: `/incidents/${id}/participants/users`, ...authHeaders(admin), payload: { userId } });
        expect(response.statusCode).toBe(409);
      });

      it("rejects further lifecycle transitions", async () => {
        const id = await createClosedIncident();
        const response = await app.inject({ method: "POST", url: `/incidents/${id}/close`, ...authHeaders(admin) });
        expect(response.statusCode).toBe(409);
      });
    });
  });

  describe("commander", () => {
    it("assigns an active User as commander without modifying their global roles", async () => {
      const { id } = await createRawIncident();
      const userId = await createTargetUser();

      const rolesBefore = await db.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId));
      expect(rolesBefore).toHaveLength(0);

      const response = await app.inject({ method: "POST", url: `/incidents/${id}/commander`, ...authHeaders(admin), payload: { userId } });
      expect(response.statusCode).toBe(200);
      expect(response.json().incident.commander.id).toBe(userId);

      const rolesAfter = await db.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId));
      expect(rolesAfter).toHaveLength(0);
    });

    it("changes commander from one active User to another", async () => {
      const { id } = await createRawIncident();
      const first = await createTargetUser();
      const second = await createTargetUser();
      await app.inject({ method: "POST", url: `/incidents/${id}/commander`, ...authHeaders(admin), payload: { userId: first } });
      const change = await app.inject({ method: "POST", url: `/incidents/${id}/commander`, ...authHeaders(admin), payload: { userId: second } });
      expect(change.json().incident.commander.id).toBe(second);
    });

    it("rejects an inactive User as commander", async () => {
      const { id } = await createRawIncident();
      const userId = await createTargetUser({ status: "inactive" });
      const response = await app.inject({ method: "POST", url: `/incidents/${id}/commander`, ...authHeaders(admin), payload: { userId } });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a nonexistent User as commander", async () => {
      const { id } = await createRawIncident();
      const response = await app.inject({ method: "POST", url: `/incidents/${id}/commander`, ...authHeaders(admin), payload: { userId: randomUUID() } });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a Contact id as commander (schema-level: only a userId field exists)", async () => {
      const { id } = await createRawIncident();
      const contactId = await createTargetContact();
      const response = await app.inject({ method: "POST", url: `/incidents/${id}/commander`, ...authHeaders(admin), payload: { contactId } });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("participants", () => {
    it("adds a User participant, prevents a duplicate, and removes without affecting the User", async () => {
      const { id } = await createRawIncident();
      const userId = await createTargetUser();

      const add = await app.inject({ method: "POST", url: `/incidents/${id}/participants/users`, ...authHeaders(admin), payload: { userId } });
      expect(add.statusCode).toBe(201);

      const dup = await app.inject({ method: "POST", url: `/incidents/${id}/participants/users`, ...authHeaders(admin), payload: { userId } });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error).toBe("duplicate_participant");

      const list = await app.inject({ method: "GET", url: `/incidents/${id}/participants`, ...authHeaders(admin) });
      const participant = list.json().items.find((p: { participantType: string }) => p.participantType === "user");
      expect(participant).toBeDefined();

      const remove = await app.inject({ method: "DELETE", url: `/incidents/${id}/participants/${participant.id}`, ...authHeaders(admin) });
      expect(remove.statusCode).toBe(204);

      const [userRow] = await db.select({ status: users.status }).from(users).where(eq(users.id, userId));
      expect(userRow!.status).toBe("active");
    });

    it("adds a Contact participant, prevents a duplicate, removes without affecting the Contact, and never creates a User", async () => {
      const { id } = await createRawIncident();
      const contactId = await createTargetContact();
      const usersBefore = await db.select({ id: users.id }).from(users);

      const add = await app.inject({ method: "POST", url: `/incidents/${id}/participants/contacts`, ...authHeaders(admin), payload: { contactId } });
      expect(add.statusCode).toBe(201);

      const dup = await app.inject({ method: "POST", url: `/incidents/${id}/participants/contacts`, ...authHeaders(admin), payload: { contactId } });
      expect(dup.statusCode).toBe(409);

      const usersAfter = await db.select({ id: users.id }).from(users);
      expect(usersAfter.length).toBe(usersBefore.length);

      const list = await app.inject({ method: "GET", url: `/incidents/${id}/participants`, ...authHeaders(admin) });
      const participant = list.json().items.find((p: { participantType: string }) => p.participantType === "contact");
      expect(participant.email).toBeNull();

      const remove = await app.inject({ method: "DELETE", url: `/incidents/${id}/participants/${participant.id}`, ...authHeaders(admin) });
      expect(remove.statusCode).toBe(204);

      const [contactRow] = await db.select({ status: contacts.status }).from(contacts).where(eq(contacts.id, contactId));
      expect(contactRow!.status).toBe("active");
    });

    it("rejects newly adding an inactive Contact", async () => {
      const { id } = await createRawIncident();
      const contactId = await createTargetContact({ status: "inactive" });
      const response = await app.inject({ method: "POST", url: `/incidents/${id}/participants/contacts`, ...authHeaders(admin), payload: { contactId } });
      expect(response.statusCode).toBe(400);
    });

    it("keeps historical participation visible after the Contact later becomes inactive", async () => {
      const { id } = await createRawIncident();
      const contactId = await createTargetContact();
      await app.inject({ method: "POST", url: `/incidents/${id}/participants/contacts`, ...authHeaders(admin), payload: { contactId } });

      await app.inject({ method: "POST", url: `/contacts/${contactId}/disable`, ...authHeaders(admin) });

      const list = await app.inject({ method: "GET", url: `/incidents/${id}/participants`, ...authHeaders(admin) });
      const participant = list.json().items.find((p: { participantType: string }) => p.participantType === "contact");
      expect(participant).toBeDefined();
      expect(participant.sourceStatus).toBe("inactive");

      await app.inject({ method: "POST", url: `/contacts/${contactId}/enable`, ...authHeaders(admin) });
    });

    it("reports correct participant counts", async () => {
      const { id } = await createRawIncident();
      const userId = await createTargetUser();
      const contactId = await createTargetContact();
      await app.inject({ method: "POST", url: `/incidents/${id}/participants/users`, ...authHeaders(admin), payload: { userId } });
      await app.inject({ method: "POST", url: `/incidents/${id}/participants/contacts`, ...authHeaders(admin), payload: { contactId } });

      const detail = await app.inject({ method: "GET", url: `/incidents/${id}`, ...authHeaders(admin) });
      expect(detail.json().incident.participantCount).toBe(2);
      expect(detail.json().incident.registeredUserCount).toBe(1);
      expect(detail.json().incident.contactParticipantCount).toBe(1);
    });

    it("allows the same User to be a participant on multiple Incidents", async () => {
      const first = await createRawIncident();
      const second = await createRawIncident();
      const userId = await createTargetUser();
      const a = await app.inject({ method: "POST", url: `/incidents/${first.id}/participants/users`, ...authHeaders(admin), payload: { userId } });
      const b = await app.inject({ method: "POST", url: `/incidents/${second.id}/participants/users`, ...authHeaders(admin), payload: { userId } });
      expect(a.statusCode).toBe(201);
      expect(b.statusCode).toBe(201);
    });
  });

  describe("timeline", () => {
    it("records the expected sequence of events and stays append-only/paginated/ordered", async () => {
      const { id } = await createRawIncident({ severity: "info" });
      const userId = await createTargetUser();
      const contactId = await createTargetContact();

      await app.inject({ method: "POST", url: `/incidents/${id}/commander`, ...authHeaders(admin), payload: { userId } });
      await app.inject({ method: "POST", url: `/incidents/${id}/participants/contacts`, ...authHeaders(admin), payload: { contactId } });
      await app.inject({ method: "PATCH", url: `/incidents/${id}`, ...authHeaders(admin), payload: { severity: "critical" } });
      await app.inject({ method: "POST", url: `/incidents/${id}/activate`, ...authHeaders(admin) });
      const list = await app.inject({ method: "GET", url: `/incidents/${id}/participants`, ...authHeaders(admin) });
      const participantId = list.json().items[0].id;
      await app.inject({ method: "DELETE", url: `/incidents/${id}/participants/${participantId}`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${id}/resolve`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${id}/close`, ...authHeaders(admin) });

      const timeline = await app.inject({ method: "GET", url: `/incidents/${id}/timeline?order=asc`, ...authHeaders(admin) });
      const eventTypes = timeline.json().items.map((e: { eventType: string }) => e.eventType);
      expect(eventTypes).toEqual([
        "INCIDENT_CREATED",
        "COMMANDER_ASSIGNED",
        "PARTICIPANT_ADDED",
        "SEVERITY_CHANGED",
        "INCIDENT_ACTIVATED",
        "PARTICIPANT_REMOVED",
        "INCIDENT_RESOLVED",
        "INCIDENT_CLOSED",
      ]);

      const createdEvent = timeline.json().items[0];
      expect(createdEvent.actorUserId).toBe(admin.id);
      expect(createdEvent.actorDisplayName).toBeTruthy();

      const paged = await app.inject({ method: "GET", url: `/incidents/${id}/timeline?page=1&pageSize=3&order=asc`, ...authHeaders(admin) });
      expect(paged.json().items).toHaveLength(3);
      expect(paged.json().total).toBe(8);
    });

    it("contains no Contact PII in metadata", async () => {
      const { id } = await createRawIncident();
      const contactId = await createTargetContact();
      await app.inject({ method: "POST", url: `/incidents/${id}/participants/contacts`, ...authHeaders(admin), payload: { contactId } });

      const [contactRow] = await db.select({ email: contacts.email, firstName: contacts.firstName }).from(contacts).where(eq(contacts.id, contactId));

      const timeline = await app.inject({ method: "GET", url: `/incidents/${id}/timeline`, ...authHeaders(admin) });
      const serialized = JSON.stringify(timeline.json());
      expect(serialized).not.toContain(contactRow!.firstName);
    });
  });

  describe("audit trail and response safety", () => {
    it("records global audit events for the full lifecycle without leaking auth fields", async () => {
      const { id } = await createRawIncident();
      await app.inject({ method: "POST", url: `/incidents/${id}/activate`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${id}/resolve`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${id}/close`, ...authHeaders(admin) });

      const events = await db.select({ eventType: auditLogs.eventType }).from(auditLogs).where(eq(auditLogs.incidentId, id));
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("INCIDENT_CREATED");
      expect(eventTypes).toContain("INCIDENT_ACTIVATED");
      expect(eventTypes).toContain("INCIDENT_RESOLVED");
      expect(eventTypes).toContain("INCIDENT_CLOSED");

      const detail = await app.inject({ method: "GET", url: `/incidents/${id}`, ...authHeaders(admin) });
      const serialized = JSON.stringify(detail.json());
      expect(serialized).not.toMatch(/passwordHash|argon2|mfa|sessionToken|recoveryCode/i);
    });
  });
});
