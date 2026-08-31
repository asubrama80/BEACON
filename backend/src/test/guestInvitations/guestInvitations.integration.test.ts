/**
 * Integration tests for Module 17's Guest Invitations, run end-to-end against a live PostgreSQL
 * database with SMS_PROVIDER=mock/EMAIL_PROVIDER=mock. Skipped when DATABASE_URL isn't reachable.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, users, roles, userRoles, incidents, guestInvitations, incidentTimelineEvents, auditLogs, type Database } from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("guest invitation routes (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500", SMS_PROVIDER: "mock", EMAIL_PROVIDER: "mock" });
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C17";
  const createdUserIds: string[] = [];
  const createdIncidentIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode: string): Promise<{ id: string; token: string; csrf: string }> {
    const email = `test-guestinv-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `Guest Invitation Test ${roleCode}`, passwordHash })
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
  let commander: { id: string; token: string; csrf: string };
  let responder: { id: string; token: string; csrf: string };
  let auditor: { id: string; token: string; csrf: string };

  beforeAll(async () => {
    admin = await createActor("ADMIN");
    commander = await createActor("INCIDENT_COMMANDER");
    responder = await createActor("RESPONDER");
    auditor = await createActor("AUDITOR");
  });

  afterAll(async () => {
    for (const id of createdIncidentIds) {
      await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
      await db.delete(incidentTimelineEvents).where(eq(incidentTimelineEvents.incidentId, id));
      await db.delete(guestInvitations).where(eq(guestInvitations.incidentId, id));
      await db.delete(incidents).where(eq(incidents.id, id));
    }
    for (const id of createdUserIds) {
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
      await db.delete(users).where(eq(users.id, id));
    }
    await app.close();
  });

  async function createRawIncident(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/incidents",
      ...authHeaders(admin),
      payload: { title: `Guest Invitation Test Incident ${tag}-${randomUUID().slice(0, 6)}`, severity: "warning" },
    });
    const id = response.json().incident.id as string;
    createdIncidentIds.push(id);
    return id;
  }

  async function closeIncident(incidentId: string): Promise<void> {
    await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(admin) });
    await app.inject({ method: "POST", url: `/incidents/${incidentId}/resolve`, ...authHeaders(admin) });
    await app.inject({ method: "POST", url: `/incidents/${incidentId}/close`, ...authHeaders(admin) });
  }

  function createInvitation(incidentId: string, body: Record<string, unknown>, actor = commander) {
    return app.inject({ method: "POST", url: `/incidents/${incidentId}/guest-invitations`, ...authHeaders(actor), payload: body });
  }
  function listInvitations(incidentId: string, actor = commander) {
    return app.inject({ method: "GET", url: `/incidents/${incidentId}/guest-invitations`, ...authHeaders(actor) });
  }
  function revokeInvitation(incidentId: string, invitationId: string, actor = commander) {
    return app.inject({ method: "POST", url: `/incidents/${incidentId}/guest-invitations/${invitationId}/revoke`, ...authHeaders(actor) });
  }
  function publicLookup(token: string) {
    return app.inject({ method: "GET", url: `/guest/invitations/${encodeURIComponent(token)}` });
  }
  function extractRawToken(invitationUrl: string): string {
    const token = invitationUrl.split("/guest/invite/")[1];
    if (!token) throw new Error(`invitationUrl did not contain a raw token: ${invitationUrl}`);
    return token;
  }

  describe("creation", () => {
    it("creates an invitation, returns the raw invitation URL exactly once, and never persists the raw token", async () => {
      const incidentId = await createRawIncident();
      const response = await createInvitation(incidentId, { guestName: "Jane Guest", email: "jane.guest@example.invalid" });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.invitationUrl).toContain("/guest/invite/");
      expect(body.invitation.status).toBe("sent"); // mock provider "delivers" synchronously

      const rawToken = body.invitationUrl.split("/guest/invite/")[1];
      const [row] = await db.select().from(guestInvitations).where(eq(guestInvitations.id, body.invitation.id));
      expect(row!.tokenHash).not.toBe(rawToken);
      expect(JSON.stringify(row)).not.toContain(rawToken);
    });

    it("never exposes the token or token hash in any authenticated API response", async () => {
      const incidentId = await createRawIncident();
      const created = await createInvitation(incidentId, { guestName: "No Leak", email: "no-leak@example.invalid" });
      const list = await listInvitations(incidentId);
      const get = await app.inject({
        method: "GET",
        url: `/incidents/${incidentId}/guest-invitations/${created.json().invitation.id}`,
        ...authHeaders(commander),
      });
      for (const response of [list, get]) {
        const serialized = JSON.stringify(response.json());
        expect(serialized).not.toMatch(/tokenHash|token_hash/i);
      }
    });

    it("normalizes the destination (email lowercased/trimmed)", async () => {
      const incidentId = await createRawIncident();
      const response = await createInvitation(incidentId, { guestName: "Case Test", email: "  Mixed.Case@Example.invalid  " });
      expect(response.statusCode).toBe(201);
      expect(response.json().invitation.email).toBe("mixed.case@example.invalid");
    });

    it("rejects invalid email/phone destinations", async () => {
      const incidentId = await createRawIncident();
      const response = await createInvitation(incidentId, { guestName: "Bad Destination", email: "not-an-email" });
      expect(response.statusCode).toBe(400);
    });

    it("requires at least one destination", async () => {
      const incidentId = await createRawIncident();
      const response = await createInvitation(incidentId, { guestName: "No Destination" });
      expect(response.statusCode).toBe(400);
    });

    it("creates no users row and assigns no role", async () => {
      const incidentId = await createRawIncident();
      const before = await db.select({ id: users.id }).from(users);
      await createInvitation(incidentId, { guestName: "Ghost", email: "ghost@example.invalid" });
      const after = await db.select({ id: users.id }).from(users);
      expect(after.length).toBe(before.length);
    });

    it("rejects creation on a CLOSED Incident", async () => {
      const incidentId = await createRawIncident();
      await closeIncident(incidentId);
      const response = await createInvitation(incidentId, { guestName: "Too Late", email: "too-late@example.invalid" });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("incident_closed");
    });

    it("rejects a duplicate active invitation to the same destination on the same Incident", async () => {
      const incidentId = await createRawIncident();
      const first = await createInvitation(incidentId, { guestName: "Dup One", email: "dup@example.invalid" });
      expect(first.statusCode).toBe(201);
      const second = await createInvitation(incidentId, { guestName: "Dup Two", email: "dup@example.invalid" });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("invitation_already_active");
    });

    it("allows re-inviting the same destination after the prior invitation is revoked", async () => {
      const incidentId = await createRawIncident();
      const first = await createInvitation(incidentId, { guestName: "Retry One", email: "retry@example.invalid" });
      await revokeInvitation(incidentId, first.json().invitation.id);
      const second = await createInvitation(incidentId, { guestName: "Retry Two", email: "retry@example.invalid" });
      expect(second.statusCode).toBe(201);
    });

    it("does not require a real SMS/email provider (mock is sufficient)", async () => {
      const incidentId = await createRawIncident();
      const response = await createInvitation(incidentId, { guestName: "Mock Only", mobilePhone: "2124567890" });
      expect(response.statusCode).toBe(201);
    });
  });

  describe("revocation", () => {
    it("revokes an invitation, and revocation is idempotent-safe (second revoke is a no-op, not an error)", async () => {
      const incidentId = await createRawIncident();
      const created = await createInvitation(incidentId, { guestName: "Revoke Me", email: "revoke-me@example.invalid" });
      const invitationId = created.json().invitation.id as string;

      const first = await revokeInvitation(incidentId, invitationId);
      expect(first.statusCode).toBe(200);
      expect(first.json().status).toBe("revoked");

      const second = await revokeInvitation(incidentId, invitationId);
      expect(second.statusCode).toBe(200);
      expect(second.json().status).toBe("revoked");

      const [row] = await db.select({ revokedAt: guestInvitations.revokedAt }).from(guestInvitations).where(eq(guestInvitations.id, invitationId));
      expect(row!.revokedAt).not.toBeNull();
    });

    it("never hard-deletes invitation history on revoke", async () => {
      const incidentId = await createRawIncident();
      const created = await createInvitation(incidentId, { guestName: "History Kept", email: "history@example.invalid" });
      await revokeInvitation(incidentId, created.json().invitation.id);
      const [row] = await db.select().from(guestInvitations).where(eq(guestInvitations.id, created.json().invitation.id));
      expect(row).toBeDefined();
    });
  });

  describe("public landing page lookup", () => {
    it("returns valid:true with only safe, minimal fields for a fresh invitation", async () => {
      const incidentId = await createRawIncident();
      const created = await createInvitation(incidentId, { guestName: "Public Look", email: "public-look@example.invalid" });
      const rawToken = extractRawToken(created.json().invitationUrl as string);

      const response = await publicLookup(rawToken);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.valid).toBe(true);
      expect(body.guestName).toBe("Public Look");
      expect(body.maskedDestination).not.toBe("public-look@example.invalid");
      expect(body.maskedDestination).toContain("@example.invalid");

      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/tokenHash|invitedBy|inviterId|token_hash/i);
    });

    it("returns valid:false with a generic reason for an unknown token, without leaking existence info", async () => {
      const response = await publicLookup("this-token-does-not-exist-" + randomUUID());
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ valid: false, reason: "not_found" });
    });

    it("returns valid:false for a revoked invitation", async () => {
      const incidentId = await createRawIncident();
      const created = await createInvitation(incidentId, { guestName: "Revoked Lookup", email: "revoked-lookup@example.invalid" });
      const rawToken = extractRawToken(created.json().invitationUrl as string);
      await revokeInvitation(incidentId, created.json().invitation.id);

      const response = await publicLookup(rawToken);
      expect(response.json()).toMatchObject({ valid: false, reason: "revoked" });
    });

    it("returns valid:false for an invitation on a CLOSED Incident", async () => {
      const incidentId = await createRawIncident();
      const created = await createInvitation(incidentId, { guestName: "Closed Lookup", email: "closed-lookup@example.invalid" });
      const rawToken = extractRawToken(created.json().invitationUrl as string);
      await closeIncident(incidentId);

      const response = await publicLookup(rawToken);
      expect(response.json()).toMatchObject({ valid: false, reason: "incident_not_eligible" });
    });

    it("requires no authentication and no CSRF token", async () => {
      const incidentId = await createRawIncident();
      const created = await createInvitation(incidentId, { guestName: "No Auth Needed", email: "no-auth@example.invalid" });
      const rawToken = extractRawToken(created.json().invitationUrl as string);
      const response = await app.inject({ method: "GET", url: `/guest/invitations/${rawToken}` });
      expect(response.statusCode).toBe(200);
    });
  });

  describe("permission matrix", () => {
    it("AUDITOR can read but cannot invite or revoke", async () => {
      const incidentId = await createRawIncident();
      expect((await listInvitations(incidentId, auditor)).statusCode).toBe(200);
      expect((await createInvitation(incidentId, { guestName: "X", email: "x@example.invalid" }, auditor)).statusCode).toBe(403);
    });

    it("RESPONDER can read but cannot invite or revoke", async () => {
      const incidentId = await createRawIncident();
      expect((await listInvitations(incidentId, responder)).statusCode).toBe(200);
      expect((await createInvitation(incidentId, { guestName: "Y", email: "y@example.invalid" }, responder)).statusCode).toBe(403);
    });

    it("INCIDENT_COMMANDER can invite and revoke", async () => {
      const incidentId = await createRawIncident();
      const created = await createInvitation(incidentId, { guestName: "Cmdr", email: "cmdr@example.invalid" }, commander);
      expect(created.statusCode).toBe(201);
      expect((await revokeInvitation(incidentId, created.json().invitation.id, commander)).statusCode).toBe(200);
    });

    it("requires authentication for the management API", async () => {
      const incidentId = await createRawIncident();
      const response = await app.inject({ method: "GET", url: `/incidents/${incidentId}/guest-invitations` });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("audit and timeline", () => {
    it("records GUEST_INVITATION_CREATED and GUEST_INVITATION_REVOKED without token/OTP/PII", async () => {
      const incidentId = await createRawIncident();
      const created = await createInvitation(incidentId, { guestName: "Audit Me", email: "audit-me@example.invalid" });
      await revokeInvitation(incidentId, created.json().invitation.id);

      const events = await db.select().from(auditLogs).where(eq(auditLogs.incidentId, incidentId));
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("GUEST_INVITATION_CREATED");
      expect(eventTypes).toContain("GUEST_INVITATION_REVOKED");
      const serialized = JSON.stringify(events);
      expect(serialized).not.toMatch(/tokenHash|token_hash|audit-me@example\.invalid/i);
    });

    it("records a GUEST_INVITED timeline event without destination PII", async () => {
      const incidentId = await createRawIncident();
      await createInvitation(incidentId, { guestName: "Timeline Guest", email: "timeline-guest@example.invalid" });

      const timeline = await app.inject({ method: "GET", url: `/incidents/${incidentId}/timeline`, ...authHeaders(admin) });
      const items = timeline.json().items as Array<{ eventType: string }>;
      expect(items.some((e) => e.eventType === "GUEST_INVITED")).toBe(true);
      expect(JSON.stringify(timeline.json())).not.toContain("timeline-guest@example.invalid");
    });
  });
});
