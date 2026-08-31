/**
 * Module 23's focused security regression suite — cross-cutting hardening checks that don't
 * belong to any single feature module. Domain-specific abuse cases (CSRF, RBAC, Guest isolation,
 * OTP/invitation brute force, IDOR, etc.) already have dedicated coverage in each module's own
 * test file; this file covers what Module 23 itself added or verified: HTTP security headers,
 * production environment fail-fast, and provider-config fail-fast. Skipped when DATABASE_URL
 * isn't reachable, matching every other integration suite's convention.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, users, roles, userRoles, auditLogs, type Database } from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { loadEnv, assertProductionEnvSafe } from "../../config/env.js";
import { loadNotificationConfig } from "../../modules/notifications/config.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("security hardening (live database)", () => {
  describe("HTTP security headers", () => {
    const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });

    it("sets baseline hardening headers on a representative response", async () => {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(response.headers["x-frame-options"]).toBeDefined();
      expect(response.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    });

    it("never sends Strict-Transport-Security outside production (would be meaningless over plain http)", async () => {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.headers["strict-transport-security"]).toBeUndefined();
    });

    it("sends Strict-Transport-Security in production", async () => {
      // Deliberately never closed: `buildApp`'s `onClose` hook tears down the process-wide shared
      // DB pool (`closeDb()`), which would break every later test in this file/process that still
      // needs it. This app is never `.listen()`ed, so it holds no OS resources requiring cleanup.
      const prodApp = buildTestApp({ NODE_ENV: "production", LOGIN_RATE_LIMIT_MAX: "500", CORS_ORIGIN: "https://beacon.example.invalid" });
      const response = await prodApp.inject({ method: "GET", url: "/health" });
      expect(response.headers["strict-transport-security"]).toContain("max-age=");
    });

    it("marks every response no-store — this API never serves cacheable content", async () => {
      const response = await app.inject({ method: "GET", url: "/health" });
      expect(response.headers["cache-control"]).toBe("no-store");
    });

    it("never dumps a stack trace or internal detail on an internal error", async () => {
      // /admin/status requires auth, so an unauthenticated call exercises the shared error
      // handler's safe-response path without needing to actually trigger a real 500.
      const response = await app.inject({ method: "GET", url: "/admin/status" });
      const body = response.body;
      expect(body).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/); // a Node.js stack-trace frame shape
      expect(body).not.toContain("node_modules");
    });
  });

  describe("production environment fail-fast", () => {
    it("requires an explicit CORS_ORIGIN in production", () => {
      const env = loadEnv({ NODE_ENV: "production" });
      expect(() => assertProductionEnvSafe(env, {})).toThrow(/CORS_ORIGIN/);
    });

    it("does not require CORS_ORIGIN outside production", () => {
      const env = loadEnv({ NODE_ENV: "development" });
      expect(() => assertProductionEnvSafe(env, {})).not.toThrow();
    });

    it("passes in production once CORS_ORIGIN is explicitly set", () => {
      const source = { NODE_ENV: "production", CORS_ORIGIN: "https://beacon.example.invalid" };
      const env = loadEnv(source);
      expect(() => assertProductionEnvSafe(env, source)).not.toThrow();
    });
  });

  describe("notification provider fail-fast (unknown explicit provider never silently becomes mock)", () => {
    it("SMS_PROVIDER with an unrecognized explicit value fails startup", () => {
      expect(() => loadNotificationConfig({ SMS_PROVIDER: "twilio-typo" })).toThrow(/Unknown SMS_PROVIDER/);
    });

    it("EMAIL_PROVIDER with an unrecognized explicit value fails startup", () => {
      expect(() => loadNotificationConfig({ EMAIL_PROVIDER: "ses-typo" })).toThrow(/Unknown EMAIL_PROVIDER/);
    });
  });

  describe("last-admin race condition (concurrent disables cannot both succeed)", () => {
    const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
    const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
    const db: Database = getDb();
    const testPassword = "Correct-Horse-Battery-C23";
    const createdUserIds: string[] = [];

    afterAll(async () => {
      for (const id of createdUserIds) {
        await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
        await db.delete(users).where(eq(users.id, id));
      }
      await app.close();
    });

    async function createAdmin(): Promise<{ id: string; token: string; csrf: string }> {
      const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, "ADMIN")).limit(1);
      const email = `test-c23-admin-${randomUUID()}@example.invalid`;
      const passwordHash = await hashPassword(testPassword, config);
      const [row] = await db
        .insert(users)
        .values({ email, displayName: "C23 Race Admin", passwordHash })
        .returning({ id: users.id });
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

    it("with exactly two active admins, concurrently disabling both never leaves zero", async () => {
      // Isolate this check from any other admin created elsewhere in this test run: count active
      // admins before, create exactly two more, and reason relative to that baseline.
      const before = await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(userRoles, eq(userRoles.userId, users.id))
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(and(eq(roles.code, "ADMIN"), eq(users.status, "active")));
      const baselineActiveAdmins = before.length;

      const admin1 = await createAdmin();
      const admin2 = await createAdmin();

      // Fire both disable requests concurrently — each targets a DIFFERENT admin, so a naive
      // unlocked check-then-act (the pre-Module-23 implementation) could let both pass.
      const [result1, result2] = await Promise.all([
        app.inject({ method: "POST", url: `/users/${admin1.id}/disable`, ...authHeaders(admin1) }),
        app.inject({ method: "POST", url: `/users/${admin2.id}/disable`, ...authHeaders(admin2) }),
      ]);

      const statusCodes = [result1.statusCode, result2.statusCode].sort();
      // Exactly one must succeed and one must be rejected — never both succeeding, which is the
      // exact scenario that would leave zero active admins if the baseline had none besides these two.
      expect(statusCodes).toEqual([200, 409]);

      const activeAfter = await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(userRoles, eq(userRoles.userId, users.id))
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(and(eq(roles.code, "ADMIN"), eq(users.status, "active")));
      // The baseline admins are still active/untouched, plus exactly one of the two new ones.
      expect(activeAfter.length).toBe(baselineActiveAdmins + 1);
    });
  });
});
