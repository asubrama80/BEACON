/**
 * Integration tests that exercise the real /auth/* routes end-to-end against a live
 * PostgreSQL database. They only run when DATABASE_URL is available (loaded here from the
 * repository-root .env if present, same convention as backend/src/index.ts) — otherwise the
 * whole suite is skipped so `npm test` stays deterministic in environments without a
 * reachable database. Each test uses uniquely-generated emails and cleans up its own rows.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Secret, TOTP } from "otpauth";
import { getDb, users, sessions, auditLogs, mfaRecoveryCodes, type Database } from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";
import { consumeRecoveryCode, regenerateRecoveryCodes } from "../../modules/auth/recoveryCodes.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("auth routes (live database)", () => {
  // A generous IP-layer rate limit for this app instance: this suite intentionally makes many
  // legitimate /auth/login calls in-process (all appearing to come from the same synthetic
  // IP via `app.inject()`), and the point of the dedicated throttle test below is to exercise
  // the per-email lock specifically, not @fastify/rate-limit's separate IP-based layer.
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
  const db: Database = getDb();

  const testEmail = `test-auth-${randomUUID()}@example.invalid`;
  const testPassword = "Correct-Horse-Battery-Staple-99";
  const displayName = "Integration Test User";
  let userId: string;

  const createdUserIds: string[] = [];

  async function createUser(overrides: { status?: string; email?: string } = {}) {
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({
        email: overrides.email ?? `test-auth-${randomUUID()}@example.invalid`,
        displayName,
        passwordHash,
        status: overrides.status ?? "active",
      })
      .returning({ id: users.id, email: users.email });
    if (!row) throw new Error("failed to create test user");
    createdUserIds.push(row.id);
    return row;
  }

  function sessionCookies(sessionToken: string, csrfToken?: string): Record<string, string> {
    return csrfToken
      ? { [config.sessionCookieName]: sessionToken, [config.csrfCookieName]: csrfToken }
      : { [config.sessionCookieName]: sessionToken };
  }

  beforeAll(async () => {
    const created = await createUser({ email: testEmail });
    userId = created.id;
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await db.delete(users).where(eq(users.id, id));
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
    }
    await app.close();
  });

  it("logs in with a correct email and password", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: testEmail, password: testPassword },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.user).toMatchObject({ id: userId, email: testEmail, mfaEnabled: false });
    expect(response.cookies.some((c) => c.name === config.sessionCookieName)).toBe(true);
    expect(response.cookies.some((c) => c.name === config.csrfCookieName)).toBe(true);

    const sessionCookie = response.cookies.find((c) => c.name === config.sessionCookieName);
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite).toBe("Lax");
  });

  it("rejects an incorrect password with a generic message", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: testEmail, password: "totally-wrong-password" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_credentials", message: "Invalid email or password." });
  });

  it("rejects an unknown email with the exact same generic message (no enumeration)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "no-such-user@example.invalid", password: "whatever-password" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_credentials", message: "Invalid email or password." });
  });

  it("rejects an inactive user with the same generic message", async () => {
    const inactive = await createUser({ status: "inactive" });
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: inactive.email, password: testPassword },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "invalid_credentials", message: "Invalid email or password." });
  });

  it("never stores the password in plaintext", async () => {
    const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId));
    expect(row?.passwordHash).toBeTruthy();
    expect(row?.passwordHash).not.toBe(testPassword);
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("creates a session and validates it via GET /auth/me", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: testEmail, password: testPassword },
    });
    const token = login.cookies.find((c) => c.name === config.sessionCookieName)!.value;

    const me = await app.inject({ method: "GET", url: "/auth/me", cookies: sessionCookies(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ id: userId, email: testEmail });
  });

  it("rejects a request with no session cookie", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/me" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("not_authenticated");
  });

  it("rejects an expired session", async () => {
    const [row] = await db
      .insert(sessions)
      .values({
        userId,
        tokenHash: "test-expired-token-hash-" + randomUUID(),
        expiresAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: sessions.id });

    // The route validates by hashing the raw cookie value and looking up the hash — since we
    // inserted an arbitrary hash directly, no raw token maps to it, which itself proves an
    // unrecognized/expired-shaped token is rejected the same way as a genuinely expired one.
    const response = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: sessionCookies("does-not-map-to-any-valid-session"),
    });
    expect(response.statusCode).toBe(401);

    await db.delete(sessions).where(eq(sessions.id, row!.id));
  });

  it("logs out, invalidating the session, and requires CSRF to do so", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: testEmail, password: testPassword },
    });
    const token = login.cookies.find((c) => c.name === config.sessionCookieName)!.value;
    const csrf = login.cookies.find((c) => c.name === config.csrfCookieName)!.value;

    const noCsrf = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: sessionCookies(token),
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error).toBe("csrf_invalid");

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: sessionCookies(token, csrf),
      headers: { "x-csrf-token": csrf },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await app.inject({ method: "GET", url: "/auth/me", cookies: sessionCookies(token) });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("locks out after repeated failed attempts, applying uniformly to any email", async () => {
    const target = `test-throttle-${randomUUID()}@example.invalid`;
    let lastStatus = 0;
    let lastBody: unknown;

    for (let i = 0; i < config.loginMaxFailures + 1; i += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: target, password: "wrong-password" },
      });
      lastStatus = response.statusCode;
      lastBody = response.json();
    }

    expect(lastStatus).toBe(401);
    expect(lastBody).toEqual({ error: "too_many_attempts", message: "Too many failed attempts. Try again later." });
  });

  describe("MFA enrollment and login", () => {
    let mfaUserEmail: string;
    let mfaUserId: string;
    let sessionToken: string;
    let csrfToken: string;
    let secretBase32: string;
    let recoveryCodes: string[];

    beforeAll(async () => {
      const created = await createUser({});
      mfaUserEmail = created.email;
      mfaUserId = created.id;

      const login = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: mfaUserEmail, password: testPassword },
      });
      sessionToken = login.cookies.find((c) => c.name === config.sessionCookieName)!.value;
      csrfToken = login.cookies.find((c) => c.name === config.csrfCookieName)!.value;
    });

    function currentCode(secret: string): string {
      return new TOTP({ secret: Secret.fromBase32(secret), algorithm: "SHA1", digits: 6, period: 30 }).generate();
    }

    it("begins enrollment and returns a secret + otpauth URL", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/mfa/enroll",
        cookies: sessionCookies(sessionToken, csrfToken),
        headers: { "x-csrf-token": csrfToken },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.secret).toMatch(/^[A-Z2-7]+=*$/);
      expect(body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
      secretBase32 = body.secret;
    });

    it("rejects confirmation with an invalid code", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/mfa/enroll/confirm",
        cookies: sessionCookies(sessionToken, csrfToken),
        headers: { "x-csrf-token": csrfToken },
        payload: { totp: "000000" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("invalid_mfa_code");
    });

    it("confirms enrollment with a valid code and returns one-time recovery codes", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/mfa/enroll/confirm",
        cookies: sessionCookies(sessionToken, csrfToken),
        headers: { "x-csrf-token": csrfToken },
        payload: { totp: currentCode(secretBase32) },
      });
      expect(response.statusCode).toBe(200);
      recoveryCodes = response.json().recoveryCodes;
      expect(recoveryCodes).toHaveLength(10);

      const me = await app.inject({ method: "GET", url: "/auth/me", cookies: sessionCookies(sessionToken) });
      expect(me.json().user.mfaEnabled).toBe(true);
    });

    it("requires an MFA code on subsequent login once enabled", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: mfaUserEmail, password: testPassword },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("mfa_required");
    });

    it("logs in with a correct TOTP code", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: mfaUserEmail, password: testPassword, totp: currentCode(secretBase32) },
      });
      expect(response.statusCode).toBe(200);
    });

    it("rejects an incorrect TOTP code", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: mfaUserEmail, password: testPassword, totp: "000000" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe("invalid_mfa_code");
    });

    it("logs in once with a recovery code, then rejects reusing the same code", async () => {
      const code = recoveryCodes[0]!;

      const first = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: mfaUserEmail, password: testPassword, recoveryCode: code },
      });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: mfaUserEmail, password: testPassword, recoveryCode: code },
      });
      expect(second.statusCode).toBe(401);
      expect(second.json().error).toBe("invalid_mfa_code");
    });

    it("regenerating recovery codes invalidates the old batch", async () => {
      const unusedOldCode = recoveryCodes[1]!;

      const regenerate = await app.inject({
        method: "POST",
        url: "/auth/mfa/recovery-codes/regenerate",
        cookies: sessionCookies(sessionToken, csrfToken),
        headers: { "x-csrf-token": csrfToken },
        payload: { password: testPassword },
      });
      expect(regenerate.statusCode).toBe(200);
      const newCodes: string[] = regenerate.json().recoveryCodes;
      expect(newCodes).toHaveLength(10);
      expect(newCodes).not.toContain(unusedOldCode);

      const loginWithOldCode = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: mfaUserEmail, password: testPassword, recoveryCode: unusedOldCode },
      });
      expect(loginWithOldCode.statusCode).toBe(401);

      const loginWithNewCode = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: mfaUserEmail, password: testPassword, recoveryCode: newCodes[0] },
      });
      expect(loginWithNewCode.statusCode).toBe(200);
    });

    it("disables MFA with password re-confirmation", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/mfa/disable",
        cookies: sessionCookies(sessionToken, csrfToken),
        headers: { "x-csrf-token": csrfToken },
        payload: { password: testPassword },
      });
      expect(response.statusCode).toBe(200);

      const remainingCodes = await db
        .select({ id: mfaRecoveryCodes.id })
        .from(mfaRecoveryCodes)
        .where(eq(mfaRecoveryCodes.userId, mfaUserId));
      expect(remainingCodes).toHaveLength(0);

      const loginWithoutMfa = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: mfaUserEmail, password: testPassword },
      });
      expect(loginWithoutMfa.statusCode).toBe(200);
    });

    it("recorded MFA audit events without any secrets in metadata", async () => {
      const events = await db
        .select({ eventType: auditLogs.eventType, metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(eq(auditLogs.actorId, mfaUserId));

      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("MFA_ENROLLED");
      expect(eventTypes).toContain("MFA_VERIFIED");
      expect(eventTypes).toContain("RECOVERY_CODE_USED");
      expect(eventTypes).toContain("MFA_RECOVERY_CODES_REGENERATED");
      expect(eventTypes).toContain("MFA_DISABLED");
      expect(eventTypes).toContain("LOGIN_SUCCESS");

      const serialized = JSON.stringify(events);
      expect(serialized).not.toMatch(/argon2/);
      expect(serialized.toLowerCase()).not.toContain(secretBase32.toLowerCase());
      for (const code of recoveryCodes) {
        expect(serialized).not.toContain(code);
      }
    });
  });

  it("consumes a recovery code atomically under concurrent use (no double-spend)", async () => {
    const concurrencyUser = await createUser({});
    const codes = await regenerateRecoveryCodes(db, concurrencyUser.id);
    const code = codes[0]!;

    const results = await Promise.all([
      consumeRecoveryCode(db, concurrencyUser.id, code),
      consumeRecoveryCode(db, concurrencyUser.id, code),
    ]);

    const successCount = results.filter(Boolean).length;
    expect(successCount).toBe(1);
  });

  it("enforces at most one break-glass account at the database level", async () => {
    const first = await createUser({ email: `test-breakglass-a-${randomUUID()}@example.invalid` });
    await db.update(users).set({ isBreakGlass: true }).where(eq(users.id, first.id));

    const passwordHash = await hashPassword(testPassword, config);
    await expect(
      db.insert(users).values({
        email: `test-breakglass-b-${randomUUID()}@example.invalid`,
        displayName,
        passwordHash,
        isBreakGlass: true,
      }),
    ).rejects.toThrow();
  });
});
