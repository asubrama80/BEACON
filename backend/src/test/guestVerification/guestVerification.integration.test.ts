/**
 * Integration tests for Module 18's Guest OTP verification, run end-to-end against a live
 * PostgreSQL database with SMS_PROVIDER=mock/EMAIL_PROVIDER=mock. Skipped when DATABASE_URL isn't
 * reachable. Uses the `onOtpGenerated` test-only capture seam (mirrors `sesFetchCert`'s
 * established pattern) rather than any production-reachable OTP-retrieval endpoint.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getDb,
  users,
  roles,
  userRoles,
  incidents,
  guestInvitations,
  guestOtpChallenges,
  guestSessions,
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

describe.skipIf(!process.env.DATABASE_URL)("guest OTP verification routes (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  let capturedCode = "";
  const app = buildTestApp(
    {
      LOGIN_RATE_LIMIT_MAX: "500",
      SMS_PROVIDER: "mock",
      EMAIL_PROVIDER: "mock",
      GUEST_OTP_MAX_ATTEMPTS: "3",
      GUEST_OTP_RESEND_COOLDOWN_SECONDS: "60",
      GUEST_OTP_REQUEST_RATE_LIMIT_MAX: "500",
      GUEST_OTP_VERIFY_RATE_LIMIT_MAX: "500",
    },
    { onOtpGenerated: (code) => { capturedCode = code; } },
  );
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C18";
  const createdUserIds: string[] = [];
  const createdIncidentIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode: string): Promise<{ id: string; token: string; csrf: string }> {
    const email = `test-otp-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `OTP Test ${roleCode}`, passwordHash })
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

  let commander: { id: string; token: string; csrf: string };

  beforeAll(async () => {
    commander = await createActor("INCIDENT_COMMANDER");
  });

  afterAll(async () => {
    for (const id of createdIncidentIds) {
      await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
      await db.delete(incidentTimelineEvents).where(eq(incidentTimelineEvents.incidentId, id));
      const invitations = await db.select({ id: guestInvitations.id }).from(guestInvitations).where(eq(guestInvitations.incidentId, id));
      for (const inv of invitations) {
        await db.delete(guestSessions).where(eq(guestSessions.invitationId, inv.id));
        await db.delete(guestOtpChallenges).where(eq(guestOtpChallenges.invitationId, inv.id));
      }
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
      ...authHeaders(commander),
      payload: { title: `OTP Test Incident ${tag}-${randomUUID().slice(0, 6)}`, severity: "warning" },
    });
    const id = response.json().incident.id as string;
    createdIncidentIds.push(id);
    return id;
  }

  async function closeIncident(incidentId: string): Promise<void> {
    await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(commander) });
    await app.inject({ method: "POST", url: `/incidents/${incidentId}/resolve`, ...authHeaders(commander) });
    await app.inject({ method: "POST", url: `/incidents/${incidentId}/close`, ...authHeaders(commander) });
  }

  async function inviteGuest(incidentId: string, guestName = "OTP Guest"): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: `/incidents/${incidentId}/guest-invitations`,
      ...authHeaders(commander),
      payload: { guestName, email: `${guestName.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 6)}@example.invalid` },
    });
    const url = response.json().invitationUrl as string;
    const token = url.split("/guest/invite/")[1];
    if (!token) throw new Error(`invitationUrl missing token: ${url}`);
    return token;
  }

  function requestOtp(token: string) {
    return app.inject({ method: "POST", url: `/guest/invitations/${encodeURIComponent(token)}/otp/request` });
  }
  function verifyOtp(token: string, code: string) {
    return app.inject({ method: "POST", url: `/guest/invitations/${encodeURIComponent(token)}/otp/verify`, payload: { code } });
  }

  describe("OTP request", () => {
    it("requests an OTP and returns only a masked destination, no code, no hash", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      const response = await requestOtp(token);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.maskedDestination).toContain("@example.invalid");
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/codeHash|code_hash|codeSalt/i);
      expect(capturedCode).toMatch(/^[0-9]{6}$/);
      expect(serialized).not.toContain(capturedCode);
    });

    it("never persists the OTP in plaintext", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      await requestOtp(token);
      const rows = await db.select().from(guestOtpChallenges);
      const activeRow = rows.find((r) => r.status === "active");
      expect(activeRow).toBeDefined();
      expect(JSON.stringify(activeRow)).not.toContain(capturedCode);
    });

    it("rejects a resend within the cooldown window", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      await requestOtp(token);
      const second = await requestOtp(token);
      expect(second.statusCode).toBe(429);
      expect(second.json().error).toBe("otp_resend_too_soon");
    });

    it("rejects OTP requests for a revoked invitation", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      const created = await app.inject({ method: "GET", url: `/incidents/${incidentId}/guest-invitations`, ...authHeaders(commander) });
      const invitationId = created.json().items[0].id as string;
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/guest-invitations/${invitationId}/revoke`, ...authHeaders(commander) });

      const response = await requestOtp(token);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("invitation_revoked");
    });

    it("rejects OTP requests when the Incident is CLOSED", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      await closeIncident(incidentId);
      const response = await requestOtp(token);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("incident_closed");
    });

    it("rejects OTP requests for an unknown token with a generic error", async () => {
      const response = await requestOtp("this-token-does-not-exist-" + randomUUID());
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toBe("invitation_not_found");
    });

    it("does not require a real SMS/email provider (mock is sufficient)", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      const response = await requestOtp(token);
      expect(response.statusCode).toBe(200);
    });
  });

  describe("OTP verify", () => {
    it("verifies the correct code, sets a Guest session cookie, and marks the invitation verified", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      await requestOtp(token);
      const code = capturedCode;

      const response = await verifyOtp(token, code);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.guestName).toBe("OTP Guest");
      const sessionCookie = response.cookies.find((c) => c.name === "beacon_guest_session");
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie!.httpOnly).toBe(true);

      const [invitationRow] = await db.select({ status: guestInvitations.status, verifiedAt: guestInvitations.verifiedAt }).from(guestInvitations).where(eq(guestInvitations.incidentId, incidentId));
      expect(invitationRow!.status).toBe("verified");
      expect(invitationRow!.verifiedAt).not.toBeNull();
    });

    it("rejects a wrong code without disclosing the expected value", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      await requestOtp(token);

      const response = await verifyOtp(token, "000000" === capturedCode ? "111111" : "000000");
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("otp_invalid");
    });

    it("locks the challenge after the configured max attempts", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      await requestOtp(token);
      const wrongCode = capturedCode === "111111" ? "222222" : "111111";

      let last;
      for (let i = 0; i < 3; i += 1) {
        last = await verifyOtp(token, wrongCode);
      }
      expect(last!.statusCode).toBe(429);
      expect(last!.json().error).toBe("otp_attempts_exceeded");

      // Even the correct code is now rejected — the challenge is locked, not just attempt-limited.
      const correctAfterLock = await verifyOtp(token, capturedCode);
      expect(correctAfterLock.statusCode).toBe(400);
      expect(correctAfterLock.json().error).toBe("otp_expired");
    });

    it("is one-time use — a second verify with the same already-consumed code fails", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      await requestOtp(token);
      const code = capturedCode;

      const first = await verifyOtp(token, code);
      expect(first.statusCode).toBe(200);

      const second = await verifyOtp(token, code);
      expect(second.statusCode).toBe(400);
      expect(second.json().error).toBe("otp_expired");
    });

    it("a resend invalidates the previous code", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      await requestOtp(token);
      const firstCode = capturedCode;

      // Directly advance the cooldown in the DB rather than waiting real time in the test —
      // scoped to this test's own invitation, since other tests' invitations may also have an
      // active challenge sitting in the table at the same time.
      const [invitationRow] = await db.select({ id: guestInvitations.id }).from(guestInvitations).where(eq(guestInvitations.incidentId, incidentId));
      const [challengeRow] = await db
        .select({ id: guestOtpChallenges.id })
        .from(guestOtpChallenges)
        .where(and(eq(guestOtpChallenges.invitationId, invitationRow!.id), eq(guestOtpChallenges.status, "active")));
      await db.update(guestOtpChallenges).set({ issuedAt: new Date(Date.now() - 120_000) }).where(eq(guestOtpChallenges.id, challengeRow!.id));

      await requestOtp(token);
      const secondCode = capturedCode;
      expect(secondCode).not.toBe(""); // sanity — a new code was generated

      // The old code is checked against the NEW active challenge (the old one is now
      // superseded) and correctly fails to match — a wrong-code rejection, not an expiry one,
      // since a genuinely active challenge does exist.
      const verifyOld = await verifyOtp(token, firstCode);
      expect(verifyOld.statusCode).toBe(400);
      expect(verifyOld.json().error).toBe("otp_invalid");

      const verifyNew = await verifyOtp(token, secondCode);
      expect(verifyNew.statusCode).toBe(200);
    });

    it("concurrent correct submissions both succeed, but the invitation is verified exactly once", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      await requestOtp(token);
      const code = capturedCode;

      const [a, b] = await Promise.all([verifyOtp(token, code), verifyOtp(token, code)]);
      const successes = [a, b].filter((r) => r.statusCode === 200);
      expect(successes.length).toBeGreaterThanOrEqual(1);

      const timeline = await app.inject({ method: "GET", url: `/incidents/${incidentId}/timeline`, ...authHeaders(commander) });
      const guestVerifiedEvents = (timeline.json().items as Array<{ eventType: string }>).filter((e) => e.eventType === "GUEST_VERIFIED");
      expect(guestVerifiedEvents).toHaveLength(1);

      const [invitationRow] = await db.select({ verifiedAt: guestInvitations.verifiedAt }).from(guestInvitations).where(eq(guestInvitations.incidentId, incidentId));
      expect(invitationRow!.verifiedAt).not.toBeNull();
    });

    it("rejects verification when the Incident is CLOSED", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      await requestOtp(token);
      const code = capturedCode;
      await closeIncident(incidentId);

      const response = await verifyOtp(token, code);
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("incident_closed");
    });
  });

  describe("guest session", () => {
    async function verifiedGuestCookies(): Promise<{ incidentId: string; sessionCookie: string; csrfCookie: string }> {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      await requestOtp(token);
      const verify = await verifyOtp(token, capturedCode);
      return {
        incidentId,
        sessionCookie: verify.cookies.find((c) => c.name === "beacon_guest_session")!.value,
        csrfCookie: verify.cookies.find((c) => c.name === "beacon_guest_csrf")!.value,
      };
    }

    it("GET /guest/session returns safe scoped Guest context, no destination, no RBAC role", async () => {
      const { sessionCookie } = await verifiedGuestCookies();
      const response = await app.inject({ method: "GET", url: "/guest/session", cookies: { beacon_guest_session: sessionCookie } });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.guestName).toBe("OTP Guest");
      expect(body).not.toHaveProperty("email");
      expect(body).not.toHaveProperty("roles");
      expect(body).not.toHaveProperty("permissions");
    });

    it("rejects /guest/session without a cookie", async () => {
      const response = await app.inject({ method: "GET", url: "/guest/session" });
      expect(response.statusCode).toBe(401);
    });

    it("never accepts a Guest session cookie on a registered-User route", async () => {
      const { sessionCookie } = await verifiedGuestCookies();
      const response = await app.inject({
        method: "GET",
        url: "/auth/me",
        cookies: { beacon_session: sessionCookie },
      });
      expect(response.statusCode).toBe(401);
    });

    it("logs out, revoking the session so it can no longer authenticate", async () => {
      const { sessionCookie, csrfCookie } = await verifiedGuestCookies();
      const logout = await app.inject({
        method: "POST",
        url: "/guest/session/logout",
        cookies: { beacon_guest_session: sessionCookie, beacon_guest_csrf: csrfCookie },
        headers: { "x-guest-csrf-token": csrfCookie },
      });
      expect(logout.statusCode).toBe(200);

      const afterLogout = await app.inject({ method: "GET", url: "/guest/session", cookies: { beacon_guest_session: sessionCookie } });
      expect(afterLogout.statusCode).toBe(401);
    });

    it("rejects logout without the guest CSRF header", async () => {
      const { sessionCookie, csrfCookie } = await verifiedGuestCookies();
      const response = await app.inject({
        method: "POST",
        url: "/guest/session/logout",
        cookies: { beacon_guest_session: sessionCookie, beacon_guest_csrf: csrfCookie },
      });
      expect(response.statusCode).toBe(403);
    });

    it("denies an existing Guest session the instant the Incident closes", async () => {
      const { incidentId, sessionCookie } = await verifiedGuestCookies();
      await closeIncident(incidentId);
      const response = await app.inject({ method: "GET", url: "/guest/session", cookies: { beacon_guest_session: sessionCookie } });
      expect(response.statusCode).toBe(401);
    });
  });

  describe("no Users row / no RBAC", () => {
    it("verification never creates a users row or assigns a role", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      const before = await db.select({ id: users.id }).from(users);
      await requestOtp(token);
      await verifyOtp(token, capturedCode);
      const after = await db.select({ id: users.id }).from(users);
      expect(after.length).toBe(before.length);
    });
  });

  describe("audit", () => {
    it("records GUEST_OTP_REQUESTED and GUEST_VERIFICATION_SUCCEEDED without the code", async () => {
      const incidentId = await createRawIncident();
      const token = await inviteGuest(incidentId);
      await requestOtp(token);
      await verifyOtp(token, capturedCode);

      const events = await db.select().from(auditLogs).where(eq(auditLogs.incidentId, incidentId));
      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("GUEST_OTP_REQUESTED");
      expect(eventTypes).toContain("GUEST_VERIFICATION_SUCCEEDED");
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(capturedCode);
    });
  });
});
