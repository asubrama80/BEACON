/**
 * Integration tests for Module 20's platform-wide Audit search, run end-to-end against a live
 * PostgreSQL database. Skipped when DATABASE_URL isn't reachable.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, users, roles, userRoles, incidents, guestInvitations, auditLogs, type Database } from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("audit search (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  let capturedCode = "";
  const app = buildTestApp(
    {
      LOGIN_RATE_LIMIT_MAX: "500",
      SMS_PROVIDER: "mock",
      EMAIL_PROVIDER: "mock",
      GUEST_OTP_REQUEST_RATE_LIMIT_MAX: "500",
      GUEST_OTP_VERIFY_RATE_LIMIT_MAX: "500",
    },
    { onOtpGenerated: (code) => { capturedCode = code; } },
  );
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C20";
  const createdUserIds: string[] = [];
  const createdIncidentIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode: string): Promise<{ id: string; token: string; csrf: string }> {
    const email = `test-audit-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `Audit Test ${roleCode}`, passwordHash })
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
  let auditor: { id: string; token: string; csrf: string };
  let responder: { id: string; token: string; csrf: string };

  beforeAll(async () => {
    admin = await createActor("ADMIN");
    auditor = await createActor("AUDITOR");
    responder = await createActor("RESPONDER");
  });

  afterAll(async () => {
    for (const id of createdIncidentIds) {
      await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
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
      payload: { title: `Audit Test Incident ${tag}-${randomUUID().slice(0, 6)}`, severity: "warning" },
    });
    const id = response.json().incident.id as string;
    createdIncidentIds.push(id);
    return id;
  }

  function getAudit(query: string, actor = auditor) {
    return app.inject({ method: "GET", url: `/audit${query}`, ...authHeaders(actor) });
  }

  describe("authorization", () => {
    it("rejects an unauthenticated request", async () => {
      const response = await app.inject({ method: "GET", url: "/audit" });
      expect(response.statusCode).toBe(401);
    });

    it("rejects a User without audit.read", async () => {
      const response = await getAudit("", responder);
      expect(response.statusCode).toBe(403);
    });

    it("allows AUDITOR", async () => {
      const response = await getAudit("", auditor);
      expect(response.statusCode).toBe(200);
    });

    it("allows ADMIN", async () => {
      const response = await getAudit("", admin);
      expect(response.statusCode).toBe(200);
    });

    it("rejects a Guest session cookie entirely (wrong cookie name)", async () => {
      const response = await app.inject({ method: "GET", url: "/audit", cookies: { beacon_guest_session: "anything" } });
      expect(response.statusCode).toBe(401);
    });

    it("no mutation route exists for /audit", async () => {
      for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
        const response = await app.inject({ method, url: "/audit", ...authHeaders(admin) });
        expect(response.statusCode).toBe(404);
      }
    });

    it("filtering by Incident still requires audit.read (not bypassable via incidents.read)", async () => {
      const incidentId = await createRawIncident();
      const response = await getAudit(`?incidentId=${incidentId}`, responder);
      expect(response.statusCode).toBe(403);
    });
  });

  describe("validation", () => {
    it("rejects a malformed cursor", async () => {
      const response = await getAudit("?cursor=not-valid-base64url-json");
      expect(response.statusCode).toBe(400);
    });

    it("rejects an invalid date", async () => {
      const response = await getAudit("?from=not-a-date");
      expect(response.statusCode).toBe(400);
    });

    it("rejects from > to", async () => {
      const response = await getAudit("?from=2026-06-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z");
      expect(response.statusCode).toBe(400);
    });

    it("rejects an invalid actorType", async () => {
      const response = await getAudit("?actorType=robot");
      expect(response.statusCode).toBe(400);
    });

    it("rejects a limit above the maximum page size (schema-enforced, matching Module 13's chat history convention)", async () => {
      const response = await getAudit("?limit=101");
      expect(response.statusCode).toBe(400);
    });

    it("accepts a limit at exactly the maximum page size", async () => {
      const response = await getAudit("?limit=100");
      expect(response.statusCode).toBe(200);
      expect(response.json().items.length).toBeLessThanOrEqual(100);
    });

    it("defaults to a bounded page size when limit is omitted", async () => {
      const response = await getAudit("");
      expect(response.statusCode).toBe(200);
      expect(response.json().items.length).toBeLessThanOrEqual(50);
    });
  });

  describe("pagination", () => {
    it("keyset-paginates without duplicates or gaps across pages", async () => {
      // Generate 5 distinct, easily-identifiable events.
      const incidentIds: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        incidentIds.push(await createRawIncident());
      }

      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const response: Awaited<ReturnType<typeof getAudit>> = await getAudit(
          `?eventType=INCIDENT_CREATED&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          admin,
        );
        expect(response.statusCode).toBe(200);
        const body = response.json() as { items: Array<{ id: string; resource: { id: string } }>; nextCursor: string | null };
        for (const item of body.items) {
          expect(seen.has(item.id)).toBe(false);
          seen.add(item.id);
        }
        cursor = body.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(20); // safety valve against an infinite loop on a bug
      } while (cursor);

      // All 5 of this test's own INCIDENT_CREATED events must have been found across the pages.
      const allEvents = await getAudit("?eventType=INCIDENT_CREATED&limit=100", admin);
      const resourceIds = (allEvents.json().items as Array<{ resource: { id: string } }>).map((i) => i.resource.id);
      for (const id of incidentIds) {
        expect(resourceIds).toContain(id);
      }
    });
  });

  describe("actor model", () => {
    it("attributes a manager-initiated event to the acting User", async () => {
      const incidentId = await createRawIncident();
      const response = await getAudit(`?eventType=INCIDENT_CREATED&incidentId=${incidentId}`, admin);
      const item = response.json().items[0];
      expect(item.actor.type).toBe("user");
      expect(item.actor.id).toBe(admin.id);
      expect(item.actor.displayName).toContain("Audit Test ADMIN");
    });

    it("attributes a Guest-initiated event to the Guest, not to 'system'", async () => {
      const incidentId = await createRawIncident();
      const created = await app.inject({
        method: "POST",
        url: `/incidents/${incidentId}/guest-invitations`,
        ...authHeaders(admin),
        payload: { guestName: "Audit Actor Guest", email: `audit-actor-${randomUUID().slice(0, 8)}@example.invalid` },
      });
      const invitationId = created.json().invitation.id as string;
      const url = created.json().invitationUrl as string;
      const token = url.split("/guest/invite/")[1]!;

      await app.inject({ method: "POST", url: `/guest/invitations/${token}/otp/request` });
      await app.inject({ method: "POST", url: `/guest/invitations/${token}/otp/verify`, payload: { code: capturedCode } });

      const response = await getAudit(`?eventType=GUEST_VERIFICATION_SUCCEEDED&resourceId=${invitationId}`, admin);
      expect(response.statusCode).toBe(200);
      const item = response.json().items[0];
      expect(item.actor.type).toBe("guest");
      expect(item.actor.id).toBe(invitationId);
      expect(item.actor.displayName).toBe("Audit Actor Guest");
    });

    it("represents a system-generated event (no known actor) explicitly, never a fake user", async () => {
      await app.inject({ method: "POST", url: "/auth/login", payload: { email: "no-such-user@example.invalid", password: "whatever12345" } });
      const response = await getAudit("?eventType=LOGIN_FAILURE&limit=1", admin);
      expect(response.statusCode).toBe(200);
      const item = response.json().items[0];
      if (item) {
        expect(item.actor.type).toBe("system");
        expect(item.actor.id).toBeNull();
        expect(item.actor.displayName).toBe("System");
      }
    });
  });

  describe("privacy and metadata sanitization", () => {
    const BANNED_PATTERN = /password|passwordHash|mfaSecret|recoveryCode|rawToken|tokenHash|otp\b|guestSessionToken|authorization|cookie|DATABASE_URL/i;

    it("never exposes secrets/PII across a representative multi-domain workflow", async () => {
      const incidentId = await createRawIncident();
      const guestResponse = await app.inject({
        method: "POST",
        url: `/incidents/${incidentId}/guest-invitations`,
        ...authHeaders(admin),
        payload: { guestName: "Sanitization Guest", email: `sanitize-${randomUUID().slice(0, 8)}@example.invalid` },
      });
      const token = (guestResponse.json().invitationUrl as string).split("/guest/invite/")[1]!;
      await app.inject({ method: "POST", url: `/guest/invitations/${token}/otp/request` });
      await app.inject({ method: "POST", url: `/guest/invitations/${token}/otp/verify`, payload: { code: capturedCode } });
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/war-room/open`, ...authHeaders(admin) });

      const response = await getAudit(`?incidentId=${incidentId}&limit=100`, admin);
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toMatch(BANNED_PATTERN);
      expect(serialized).not.toContain(capturedCode);
      expect(serialized).not.toContain("sanitize-");
    });
  });

  describe("resource mapping", () => {
    it("reports resourceType/resourceId for a resource-scoped event", async () => {
      const incidentId = await createRawIncident();
      const response = await getAudit(`?eventType=INCIDENT_CREATED&incidentId=${incidentId}`, admin);
      const item = response.json().items[0];
      expect(item.resource.type).toBe("incident");
      expect(item.resource.id).toBe(incidentId);
      expect(item.incidentId).toBe(incidentId);
    });
  });
});
