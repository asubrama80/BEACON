/**
 * Module 24 — time-boundary / TTL expiry tests using controlled, directly-manipulated database
 * timestamps rather than real sleeps. The pre-existing "rejects an expired session" test
 * (auth/routes.integration.test.ts) only proves an unrecognized token is rejected the same way as
 * an expired one — it never actually exercises the `expiresAt` comparison in the session-lookup
 * query. These tests create a genuinely valid session/challenge/invitation first, then push its
 * real `expiresAt` into the past and prove the corresponding auth/verify path rejects it via the
 * expiry check specifically. Skipped when DATABASE_URL isn't reachable.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  getDb,
  users,
  roles,
  userRoles,
  sessions,
  guestOtpChallenges,
  guestInvitations,
  incidents,
  auditLogs,
  type Database,
} from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("time-boundary / TTL expiry (live database, controlled timestamps)", () => {
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
  const createdUserIds: string[] = [];
  const createdIncidentIds: string[] = [];
  const testPassword = "Correct-Horse-Battery-C24-TTL";

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

  async function createAdmin(): Promise<{ id: string; token: string; csrf: string }> {
    const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, "ADMIN")).limit(1);
    const email = `test-c24-ttl-admin-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db.insert(users).values({ email, displayName: "TTL Admin", passwordHash }).returning({ id: users.id });
    createdUserIds.push(row!.id);
    await db.insert(userRoles).values({ userId: row!.id, roleId: adminRole!.id });
    const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: testPassword } });
    return {
      id: row!.id,
      token: response.cookies.find((c) => c.name === config.sessionCookieName)!.value,
      csrf: response.cookies.find((c) => c.name === config.csrfCookieName)!.value,
    };
  }

  function authHeaders(actor: { token: string; csrf: string }) {
    return {
      cookies: { [config.sessionCookieName]: actor.token, [config.csrfCookieName]: actor.csrf },
      headers: { "x-csrf-token": actor.csrf },
    };
  }

  it("a genuinely valid session is rejected once its real expiresAt has passed", async () => {
    const email = `test-c24-ttl-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [user] = await db.insert(users).values({ email, displayName: "TTL Test User", passwordHash }).returning({ id: users.id });
    createdUserIds.push(user!.id);

    const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: testPassword } });
    expect(login.statusCode).toBe(200);
    const sessionToken = login.cookies.find((c) => c.name === config.sessionCookieName)!.value;

    // Confirm the session is genuinely valid *before* manipulating it.
    const before = await app.inject({ method: "GET", url: "/auth/me", cookies: { [config.sessionCookieName]: sessionToken } });
    expect(before.statusCode).toBe(200);

    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(sessions.userId, user!.id));

    const after = await app.inject({ method: "GET", url: "/auth/me", cookies: { [config.sessionCookieName]: sessionToken } });
    expect(after.statusCode).toBe(401);
  });

  async function createInvitation(admin: { token: string; csrf: string }): Promise<{ incidentId: string; token: string; invitationId: string }> {
    const incidentResponse = await app.inject({
      method: "POST",
      url: "/incidents",
      ...authHeaders(admin),
      payload: { title: `C24 TTL Incident ${randomUUID().slice(0, 6)}`, severity: "warning" },
    });
    const incidentId = incidentResponse.json().incident.id as string;
    createdIncidentIds.push(incidentId);

    const created = await app.inject({
      method: "POST",
      url: `/incidents/${incidentId}/guest-invitations`,
      ...authHeaders(admin),
      payload: { guestName: "TTL Guest", email: `c24-ttl-guest-${randomUUID()}@example.invalid` },
    });
    const invitationId = created.json().invitation.id as string;
    const token = (created.json().invitationUrl as string).split("/guest/invite/")[1]!;
    return { incidentId, token, invitationId };
  }

  it("an OTP challenge is rejected once its real expiresAt has passed, even with the correct code", async () => {
    const admin = await createAdmin();
    const { token } = await createInvitation(admin);

    const requestResponse = await app.inject({ method: "POST", url: `/guest/invitations/${token}/otp/request` });
    expect(requestResponse.statusCode).toBe(200);
    expect(capturedCode).toMatch(/^\d{6}$/);

    await db.update(guestOtpChallenges).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(guestOtpChallenges.status, "active"));

    const verifyResponse = await app.inject({ method: "POST", url: `/guest/invitations/${token}/otp/verify`, payload: { code: capturedCode } });
    expect(verifyResponse.statusCode).toBe(400);
    expect(verifyResponse.json().error).toBe("otp_expired");
  });

  it("an invitation is rejected once its real expiresAt has passed, even before any OTP is requested", async () => {
    const admin = await createAdmin();
    const { token, invitationId } = await createInvitation(admin);

    await db.update(guestInvitations).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(guestInvitations.id, invitationId));

    const requestResponse = await app.inject({ method: "POST", url: `/guest/invitations/${token}/otp/request` });
    expect(requestResponse.statusCode).toBe(409);
    expect(requestResponse.json().error).toBe("invitation_expired");
  });
});
