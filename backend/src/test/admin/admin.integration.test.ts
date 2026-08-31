/**
 * Integration tests for Module 22's Application Administration surface, run end-to-end against a
 * live PostgreSQL database. Skipped when DATABASE_URL isn't reachable.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Secret, TOTP } from "otpauth";
import { getDb, users, roles, userRoles, auditLogs, type Database } from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("admin routes (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C22";
  const createdUserIds: string[] = [];

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode: string): Promise<{ id: string; email: string; token: string; csrf: string }> {
    const email = `test-admin-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `Admin Test ${roleCode}`, passwordHash })
      .returning({ id: users.id });
    createdUserIds.push(row!.id);
    await db.insert(userRoles).values({ userId: row!.id, roleId: await roleId(roleCode) });

    const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: testPassword } });
    if (response.statusCode !== 200) {
      throw new Error(`login failed for ${roleCode}: ${response.statusCode} ${response.body}`);
    }
    return {
      id: row!.id,
      email,
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

  let admin: { id: string; email: string; token: string; csrf: string };
  let auditor: { id: string; email: string; token: string; csrf: string };
  let responder: { id: string; email: string; token: string; csrf: string };

  beforeAll(async () => {
    admin = await createActor("ADMIN");
    auditor = await createActor("AUDITOR");
    responder = await createActor("RESPONDER");
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
      await db.delete(users).where(eq(users.id, id));
    }
    await app.close();
  });

  async function auditCountFor(eventType: string, resourceId: string): Promise<number> {
    const response = await app.inject({
      method: "GET",
      url: `/audit?eventType=${eventType}&resourceId=${resourceId}&limit=100`,
      ...authHeaders(auditor),
    });
    expect(response.statusCode).toBe(200);
    return (response.json().items as unknown[]).length;
  }

  describe("authorization: GET /admin/status", () => {
    it("rejects an unauthenticated request", async () => {
      const response = await app.inject({ method: "GET", url: "/admin/status" });
      expect(response.statusCode).toBe(401);
    });

    it("rejects a Guest session cookie entirely (wrong cookie name)", async () => {
      const response = await app.inject({ method: "GET", url: "/admin/status", cookies: { beacon_guest_session: "anything" } });
      expect(response.statusCode).toBe(401);
    });

    it("rejects a User without admin.read", async () => {
      const response = await app.inject({ method: "GET", url: "/admin/status", ...authHeaders(responder) });
      expect(response.statusCode).toBe(403);
    });

    it("allows AUDITOR (admin.read)", async () => {
      const response = await app.inject({ method: "GET", url: "/admin/status", ...authHeaders(auditor) });
      expect(response.statusCode).toBe(200);
    });

    it("allows ADMIN", async () => {
      const response = await app.inject({ method: "GET", url: "/admin/status", ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
    });
  });

  describe("GET /admin/status sanitization", () => {
    const BANNED_PATTERN =
      /DATABASE_URL|passwordHash|mfaSecret|secretKey|privateKey|apiKey|accessToken|accountSid|authToken|TWILIO|AGORA|AWS_SECRET|encryptionKey/i;

    it("never leaks secrets, credentials, or a process.env dump", async () => {
      const response = await app.inject({ method: "GET", url: "/admin/status", ...authHeaders(admin) });
      const body = response.json();
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(BANNED_PATTERN);

      // Explicit allowlisted shape — provider *names* only, never credentials.
      expect(typeof body.providers.sms).toBe("string");
      expect(typeof body.providers.email).toBe("string");
      expect(body.security.breakGlass).toHaveProperty("present");
      expect(body.security.breakGlass).not.toHaveProperty("email");
      expect(body).not.toHaveProperty("env");
      expect(typeof body.database.connected).toBe("boolean");
    });
  });

  describe("authorization: GET /admin/roles", () => {
    it("rejects a User without admin.read", async () => {
      const response = await app.inject({ method: "GET", url: "/admin/roles", ...authHeaders(responder) });
      expect(response.statusCode).toBe(403);
    });

    it("allows AUDITOR and reports the AUDITOR role's own admin.read grant", async () => {
      const response = await app.inject({ method: "GET", url: "/admin/roles", ...authHeaders(auditor) });
      expect(response.statusCode).toBe(200);
      const items = response.json().items as Array<{ code: string; permissionCodes: string[]; userCount: number }>;
      const auditorRole = items.find((r) => r.code === "AUDITOR");
      expect(auditorRole).toBeDefined();
      expect(auditorRole!.permissionCodes).toContain("admin.read");
      expect(auditorRole!.permissionCodes).not.toContain("admin.manage");
      expect(auditorRole!.userCount).toBeGreaterThanOrEqual(1);

      const adminRole = items.find((r) => r.code === "ADMIN");
      expect(adminRole!.permissionCodes).toContain("admin.manage");
    });
  });

  describe("authorization: manage actions require admin.manage", () => {
    it("rejects AUDITOR (admin.read only) from revoking sessions", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/admin/users/${responder.id}/sessions/revoke`,
        ...authHeaders(auditor),
      });
      expect(response.statusCode).toBe(403);
    });

    it("rejects AUDITOR (admin.read only) from resetting MFA", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/admin/users/${responder.id}/mfa/reset`,
        ...authHeaders(auditor),
      });
      expect(response.statusCode).toBe(403);
    });

    it("rejects an unauthenticated request to either action", async () => {
      const revoke = await app.inject({ method: "POST", url: `/admin/users/${responder.id}/sessions/revoke` });
      expect(revoke.statusCode).toBe(401);
      const reset = await app.inject({ method: "POST", url: `/admin/users/${responder.id}/mfa/reset` });
      expect(reset.statusCode).toBe(401);
    });
  });

  describe("POST /admin/users/:id/sessions/revoke", () => {
    it("returns 404 for a nonexistent target", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/admin/users/${randomUUID()}/sessions/revoke`,
        ...authHeaders(admin),
      });
      expect(response.statusCode).toBe(404);
    });

    it("rejects targeting a break-glass account", async () => {
      const target = await createActor("RESPONDER");
      await db.update(users).set({ isBreakGlass: true }).where(eq(users.id, target.id));
      try {
        const response = await app.inject({
          method: "POST",
          url: `/admin/users/${target.id}/sessions/revoke`,
          ...authHeaders(admin),
        });
        expect(response.statusCode).toBe(403);
        expect(response.json().error).toBe("break_glass_protected");
      } finally {
        await db.update(users).set({ isBreakGlass: false }).where(eq(users.id, target.id));
      }
    });

    it("invalidates the target's existing session and is audited exactly once", async () => {
      const target = await createActor("RESPONDER");

      const before = await app.inject({ method: "GET", url: "/auth/me", ...authHeaders(target) });
      expect(before.statusCode).toBe(200);

      const response = await app.inject({
        method: "POST",
        url: `/admin/users/${target.id}/sessions/revoke`,
        ...authHeaders(admin),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });

      const after = await app.inject({ method: "GET", url: "/auth/me", ...authHeaders(target) });
      expect(after.statusCode).toBe(401);

      expect(await auditCountFor("USER_SESSIONS_ADMIN_REVOKED", target.id)).toBe(1);
    });
  });

  describe("POST /admin/users/:id/mfa/reset", () => {
    function currentCode(secret: string): string {
      return new TOTP({ secret: Secret.fromBase32(secret), algorithm: "SHA1", digits: 6, period: 30 }).generate();
    }

    it("returns 409 when the target has no active MFA credential", async () => {
      const target = await createActor("RESPONDER");
      const response = await app.inject({
        method: "POST",
        url: `/admin/users/${target.id}/mfa/reset`,
        ...authHeaders(admin),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("mfa_not_enabled");
    });

    it("returns 404 for a nonexistent target", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/admin/users/${randomUUID()}/mfa/reset`,
        ...authHeaders(admin),
      });
      expect(response.statusCode).toBe(404);
    });

    it("rejects targeting a break-glass account", async () => {
      const target = await createActor("RESPONDER");
      await db.update(users).set({ isBreakGlass: true }).where(eq(users.id, target.id));
      try {
        const response = await app.inject({
          method: "POST",
          url: `/admin/users/${target.id}/mfa/reset`,
          ...authHeaders(admin),
        });
        expect(response.statusCode).toBe(403);
        expect(response.json().error).toBe("break_glass_protected");
      } finally {
        await db.update(users).set({ isBreakGlass: false }).where(eq(users.id, target.id));
      }
    });

    it("resets an enrolled target's MFA, forces re-enrollment, and is audited exactly once", async () => {
      const target = await createActor("RESPONDER");

      const enroll = await app.inject({ method: "POST", url: "/auth/mfa/enroll", ...authHeaders(target) });
      expect(enroll.statusCode).toBe(200);
      const secret = enroll.json().secret as string;

      const confirm = await app.inject({
        method: "POST",
        url: "/auth/mfa/enroll/confirm",
        ...authHeaders(target),
        payload: { totp: currentCode(secret) },
      });
      expect(confirm.statusCode).toBe(200);

      const meBefore = await app.inject({ method: "GET", url: "/auth/me", ...authHeaders(target) });
      expect(meBefore.json().user.mfaEnabled).toBe(true);

      const response = await app.inject({
        method: "POST",
        url: `/admin/users/${target.id}/mfa/reset`,
        ...authHeaders(admin),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ success: true });

      // The reset never revealed the prior secret anywhere in its own response.
      expect(JSON.stringify(response.json())).not.toContain(secret);

      const meAfter = await app.inject({ method: "GET", url: "/auth/me", ...authHeaders(target) });
      expect(meAfter.json().user.mfaEnabled).toBe(false);

      expect(await auditCountFor("MFA_ADMIN_RESET", target.id)).toBe(1);
    });
  });

  describe("last-admin protection remains intact (Module 03 regression check)", () => {
    it("cannot disable the last effective ADMIN via the existing user-management route", async () => {
      const activeAdminRows = await db
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .where(eq(userRoles.roleId, await roleId("ADMIN")));
      const soleAdminId = activeAdminRows.length === 1 ? activeAdminRows[0]!.userId : null;
      if (!soleAdminId) {
        // More than one ADMIN exists in this environment; the invariant isn't reachable here.
        return;
      }
      const response = await app.inject({
        method: "POST",
        url: `/users/${soleAdminId}/disable`,
        ...authHeaders(admin),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("last_admin_protected");
    });
  });
});
