/**
 * Integration tests for the Module 03 user-administration and RBAC routes, run end-to-end
 * against a live PostgreSQL database. Skipped when DATABASE_URL isn't reachable (same
 * convention as Module 02's suite). Test files in this workspace run sequentially
 * (`fileParallelism: false` in vitest.config.ts) specifically so the last-active-administrator
 * safeguard test below can reason about a deterministic global admin count.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, users, roles, userRoles, auditLogs, type Database } from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("users & RBAC routes (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-77";
  const createdUserIds: string[] = [];

  let adminId: string;
  let adminSession: { token: string; csrf: string };
  let noPermSession: { token: string; csrf: string };

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createRawUser(overrides: {
    email?: string;
    displayName?: string;
    isBreakGlass?: boolean;
  } = {}): Promise<string> {
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({
        email: overrides.email ?? `test-users-${randomUUID()}@example.invalid`,
        displayName: overrides.displayName ?? "Test User",
        passwordHash,
        isBreakGlass: overrides.isBreakGlass ?? false,
      })
      .returning({ id: users.id });
    createdUserIds.push(row!.id);
    return row!.id;
  }

  async function login(email: string): Promise<{ token: string; csrf: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: testPassword },
    });
    if (response.statusCode !== 200) {
      throw new Error(`login failed for ${email}: ${response.statusCode} ${response.body}`);
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

  beforeAll(async () => {
    const adminEmail = `test-admin-${randomUUID()}@example.invalid`;
    adminId = await createRawUser({ email: adminEmail, displayName: "Admin Actor" });
    await db.insert(userRoles).values({ userId: adminId, roleId: await roleId("ADMIN") });
    adminSession = await login(adminEmail);

    const noPermEmail = `test-noperm-${randomUUID()}@example.invalid`;
    await createRawUser({ email: noPermEmail, displayName: "No Permission User" });
    noPermSession = await login(noPermEmail);
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await db.delete(users).where(eq(users.id, id));
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
    }
    await app.close();
  });

  describe("authentication and authorization", () => {
    it("GET /users requires authentication", async () => {
      const response = await app.inject({ method: "GET", url: "/users" });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("not_authenticated");
    });

    it("GET /users rejects an authenticated user without users.read", async () => {
      const response = await app.inject({ method: "GET", url: "/users", ...authHeaders(noPermSession) });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("not_authorized");
    });

    it("GET /users succeeds for an authorized user with a paginated shape", async () => {
      const response = await app.inject({ method: "GET", url: "/users", ...authHeaders(adminSession) });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(typeof body.total).toBe("number");
      expect(body.page).toBe(1);
    });
  });

  describe("user creation", () => {
    it("creates a user with hashed password and no sensitive fields in the response", async () => {
      const email = `test-created-${randomUUID()}@example.invalid`;
      const response = await app.inject({
        method: "POST",
        url: "/users",
        ...authHeaders(adminSession),
        payload: { email, displayName: "Created User", initialPassword: "Another-Strong-Pass-1" },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      createdUserIds.push(body.user.id);

      expect(body.user.email).toBe(email);
      expect(JSON.stringify(body)).not.toMatch(/argon2|passwordHash/i);

      const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, body.user.id));
      expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row?.passwordHash).not.toContain("Another-Strong-Pass-1");
    });

    it("rejects a duplicate email", async () => {
      const email = `test-dup-${randomUUID()}@example.invalid`;
      const first = await app.inject({
        method: "POST",
        url: "/users",
        ...authHeaders(adminSession),
        payload: { email, displayName: "First", initialPassword: "Another-Strong-Pass-2" },
      });
      createdUserIds.push(first.json().user.id);

      const second = await app.inject({
        method: "POST",
        url: "/users",
        ...authHeaders(adminSession),
        payload: { email, displayName: "Second", initialPassword: "Another-Strong-Pass-3" },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("duplicate_email");
    });

    it("ignores unexpected fields on create — mass-assignment has no effect", async () => {
      // Fastify's default AJV config strips unknown properties for an additionalProperties:false
      // schema rather than rejecting the request (200/201), so the meaningful assertion is that
      // the forged fields never take effect — not the HTTP status.
      const response = await app.inject({
        method: "POST",
        url: "/users",
        ...authHeaders(adminSession),
        payload: {
          email: `test-mass-${randomUUID()}@example.invalid`,
          displayName: "X",
          initialPassword: "Another-Strong-Pass-4",
          passwordHash: "$argon2id$forged",
          isBreakGlass: true,
        },
      });
      expect(response.statusCode).toBe(201);
      const created = response.json().user;
      createdUserIds.push(created.id);

      expect(created.isBreakGlass).toBe(false);
      const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, created.id));
      expect(row?.passwordHash).not.toBe("$argon2id$forged");
      expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it("rejects creation without users.create permission", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/users",
        ...authHeaders(noPermSession),
        payload: {
          email: `test-forbidden-${randomUUID()}@example.invalid`,
          displayName: "X",
          initialPassword: "Another-Strong-Pass-5",
        },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  describe("user updates", () => {
    it("updates allowed fields", async () => {
      const targetId = await createRawUser();
      const response = await app.inject({
        method: "PATCH",
        url: `/users/${targetId}`,
        ...authHeaders(adminSession),
        payload: { displayName: "Renamed User" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().user.displayName).toBe("Renamed User");
    });

    it("ignores sensitive fields on PATCH — they cannot be mass-assigned", async () => {
      const targetId = await createRawUser();
      const [before] = await db
        .select({ passwordHash: users.passwordHash, status: users.status })
        .from(users)
        .where(eq(users.id, targetId));

      const response = await app.inject({
        method: "PATCH",
        url: `/users/${targetId}`,
        ...authHeaders(adminSession),
        payload: { displayName: "X", passwordHash: "$argon2id$forged", status: "suspended" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().user.displayName).toBe("X");

      const [after] = await db
        .select({ passwordHash: users.passwordHash, status: users.status })
        .from(users)
        .where(eq(users.id, targetId));
      expect(after?.passwordHash).toBe(before?.passwordHash);
      expect(after?.status).toBe(before?.status);
    });
  });

  describe("disable / enable and session revocation", () => {
    it("disabling a user revokes their active session immediately", async () => {
      const email = `test-disable-${randomUUID()}@example.invalid`;
      const targetId = await createRawUser({ email });
      const targetSession = await login(email);

      const me = await app.inject({ method: "GET", url: "/auth/me", cookies: { [config.sessionCookieName]: targetSession.token } });
      expect(me.statusCode).toBe(200);

      const disable = await app.inject({
        method: "POST",
        url: `/users/${targetId}/disable`,
        ...authHeaders(adminSession),
      });
      expect(disable.statusCode).toBe(200);
      expect(disable.json().user.status).toBe("inactive");

      const meAfter = await app.inject({
        method: "GET",
        url: "/auth/me",
        cookies: { [config.sessionCookieName]: targetSession.token },
      });
      expect(meAfter.statusCode).toBe(401);
    });

    it("re-enabling a user does not restore the old session", async () => {
      const email = `test-reenable-${randomUUID()}@example.invalid`;
      const targetId = await createRawUser({ email });
      const targetSession = await login(email);

      await app.inject({ method: "POST", url: `/users/${targetId}/disable`, ...authHeaders(adminSession) });
      await app.inject({ method: "POST", url: `/users/${targetId}/enable`, ...authHeaders(adminSession) });

      const meWithOldSession = await app.inject({
        method: "GET",
        url: "/auth/me",
        cookies: { [config.sessionCookieName]: targetSession.token },
      });
      expect(meWithOldSession.statusCode).toBe(401);

      // A fresh login works again once re-enabled.
      const freshLogin = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email, password: testPassword },
      });
      expect(freshLogin.statusCode).toBe(200);
    });
  });

  describe("role assignment", () => {
    it("assigns and removes a role", async () => {
      const targetId = await createRawUser();

      const assign = await app.inject({
        method: "POST",
        url: `/users/${targetId}/roles`,
        ...authHeaders(adminSession),
        payload: { roleCode: "RESPONDER" },
      });
      expect(assign.statusCode).toBe(201);
      expect(assign.json().user.roles.map((r: { code: string }) => r.code)).toContain("RESPONDER");

      const remove = await app.inject({
        method: "DELETE",
        url: `/users/${targetId}/roles/RESPONDER`,
        ...authHeaders(adminSession),
      });
      expect(remove.statusCode).toBe(200);
      expect(remove.json().user.roles.map((r: { code: string }) => r.code)).not.toContain("RESPONDER");
    });

    it("rejects a duplicate role assignment", async () => {
      const targetId = await createRawUser();
      await app.inject({
        method: "POST",
        url: `/users/${targetId}/roles`,
        ...authHeaders(adminSession),
        payload: { roleCode: "AUDITOR" },
      });
      const second = await app.inject({
        method: "POST",
        url: `/users/${targetId}/roles`,
        ...authHeaders(adminSession),
        payload: { roleCode: "AUDITOR" },
      });
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("role_already_assigned");
    });

    it("removing a role the user doesn't have returns 404", async () => {
      const targetId = await createRawUser();
      const response = await app.inject({
        method: "DELETE",
        url: `/users/${targetId}/roles/AUDITOR`,
        ...authHeaders(adminSession),
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe("last-administrator safeguard", () => {
    it("cannot disable the last active administrator", async () => {
      const activeAdminRows = await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(userRoles, eq(userRoles.userId, users.id))
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(and(eq(roles.code, "ADMIN"), eq(users.status, "active"), isNull(users.deletedAt)));
      expect(activeAdminRows.some((row) => row.id === adminId)).toBe(true); // sanity: adminActor is present

      const response = await app.inject({
        method: "POST",
        url: `/users/${adminId}/disable`,
        ...authHeaders(adminSession),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("last_admin_protected");

      const [row] = await db.select({ status: users.status }).from(users).where(eq(users.id, adminId));
      expect(row?.status).toBe("active");
    });

    it("cannot remove the final ADMIN role", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: `/users/${adminId}/roles/ADMIN`,
        ...authHeaders(adminSession),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("last_admin_protected");

      const stillAdmin = await db
        .select({ id: userRoles.id })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(and(eq(userRoles.userId, adminId), eq(roles.code, "ADMIN")));
      expect(stillAdmin.length).toBe(1);
    });
  });

  describe("break-glass protection", () => {
    let breakGlassId: string;

    beforeAll(async () => {
      breakGlassId = await createRawUser({
        email: `test-breakglass-${randomUUID()}@example.invalid`,
        isBreakGlass: true,
      });
    });

    it("rejects PATCH on the break-glass account", async () => {
      const response = await app.inject({
        method: "PATCH",
        url: `/users/${breakGlassId}`,
        ...authHeaders(adminSession),
        payload: { displayName: "Hijacked" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("break_glass_protected");
    });

    it("rejects disabling the break-glass account", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/users/${breakGlassId}/disable`,
        ...authHeaders(adminSession),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("break_glass_protected");
    });

    it("rejects role assignment on the break-glass account", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/users/${breakGlassId}/roles`,
        ...authHeaders(adminSession),
        payload: { roleCode: "AUDITOR" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("break_glass_protected");
    });

    it("rejects password reset on the break-glass account", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/users/${breakGlassId}/reset-password`,
        ...authHeaders(adminSession),
        payload: { newPassword: "Some-Other-Strong-Pass-9" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("break_glass_protected");
    });
  });

  describe("admin password reset", () => {
    it("resets a user's password and revokes their sessions", async () => {
      const email = `test-reset-${randomUUID()}@example.invalid`;
      const targetId = await createRawUser({ email });
      const targetSession = await login(email);

      const response = await app.inject({
        method: "POST",
        url: `/users/${targetId}/reset-password`,
        ...authHeaders(adminSession),
        payload: { newPassword: "Brand-New-Strong-Pass-1" },
      });
      expect(response.statusCode).toBe(200);

      const oldSessionMe = await app.inject({
        method: "GET",
        url: "/auth/me",
        cookies: { [config.sessionCookieName]: targetSession.token },
      });
      expect(oldSessionMe.statusCode).toBe(401);

      const newLogin = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email, password: "Brand-New-Strong-Pass-1" },
      });
      expect(newLogin.statusCode).toBe(200);
    });
  });

  describe("RBAC read endpoints", () => {
    it("GET /roles returns the five system roles", async () => {
      const response = await app.inject({ method: "GET", url: "/roles", ...authHeaders(adminSession) });
      expect(response.statusCode).toBe(200);
      const codes = response.json().roles.map((r: { code: string }) => r.code).sort();
      expect(codes).toEqual(
        ["ADMIN", "AUDITOR", "COMMUNICATION_MANAGER", "INCIDENT_COMMANDER", "RESPONDER"].sort(),
      );
    });

    it("GET /permissions returns the Module 03 permission set", async () => {
      const response = await app.inject({ method: "GET", url: "/permissions", ...authHeaders(adminSession) });
      expect(response.statusCode).toBe(200);
      expect(response.json().permissions.length).toBeGreaterThanOrEqual(7);
    });

    it("rejects /roles and /permissions without the read permission", async () => {
      const rolesResp = await app.inject({ method: "GET", url: "/roles", ...authHeaders(noPermSession) });
      const permsResp = await app.inject({ method: "GET", url: "/permissions", ...authHeaders(noPermSession) });
      expect(rolesResp.statusCode).toBe(403);
      expect(permsResp.statusCode).toBe(403);
    });
  });

  describe("audit trail", () => {
    it("records user administration events without secrets in metadata", async () => {
      const targetId = await createRawUser();
      await app.inject({ method: "POST", url: `/users/${targetId}/disable`, ...authHeaders(adminSession) });
      await app.inject({ method: "POST", url: `/users/${targetId}/enable`, ...authHeaders(adminSession) });
      await app.inject({
        method: "POST",
        url: `/users/${targetId}/roles`,
        ...authHeaders(adminSession),
        payload: { roleCode: "RESPONDER" },
      });

      const events = await db
        .select({ eventType: auditLogs.eventType, metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, targetId));

      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("USER_DISABLED");
      expect(eventTypes).toContain("USER_ENABLED");
      expect(eventTypes).toContain("USER_ROLE_ASSIGNED");

      const serialized = JSON.stringify(events);
      expect(serialized).not.toMatch(/argon2|passwordHash|\$2[aby]\$/i);
    });
  });
});
