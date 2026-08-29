import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getDb, mfaCredentials, mfaRecoveryCodes } from "@beacon/database";
import type { AuthConfig } from "./config.js";
import { verifyPassword, getDummyHash } from "./password.js";
import { createSession, revokeSession } from "./session.js";
import {
  findUserByEmail,
  findUserById,
  findActiveMfaCredential,
  findPendingMfaCredential,
  isUsableAccount,
  toAuthenticatedUser,
} from "./userAuth.js";
import { generateTotpSecret, buildOtpauthUrl, verifyTotpCode, encryptTotpSecret, decryptTotpSecret } from "./totp.js";
import { regenerateRecoveryCodes, consumeRecoveryCode } from "./recoveryCodes.js";
import { recordAuthEvent } from "./audit.js";
import { LoginThrottle } from "./loginThrottle.js";
import { setCsrfCookie, generateCsrfToken, requireCsrf } from "./csrf.js";
import { createAuthenticateHook } from "./plugin.js";
import {
  AuthError,
  INVALID_CREDENTIALS,
  TOO_MANY_ATTEMPTS,
  MFA_REQUIRED,
  INVALID_MFA_CODE,
} from "./errors.js";

interface AuthRoutesOptions {
  config: AuthConfig;
  mfaEncryptionKey: Buffer;
}

const loginBodySchema = {
  type: "object",
  required: ["email", "password"],
  properties: {
    email: { type: "string", minLength: 1, maxLength: 255 },
    password: { type: "string", minLength: 1, maxLength: 512 },
    totp: { type: "string", minLength: 6, maxLength: 6 },
    recoveryCode: { type: "string", minLength: 1, maxLength: 64 },
  },
} as const;

export async function authRoutes(app: FastifyInstance, opts: AuthRoutesOptions): Promise<void> {
  const { config, mfaEncryptionKey } = opts;
  const throttle = new LoginThrottle(config);
  const authenticate = createAuthenticateHook(config);

  app.post(
    "/auth/login",
    {
      schema: { body: loginBodySchema },
      config: {
        rateLimit: { max: config.loginRateLimitMax, timeWindow: config.loginRateLimitWindow },
      },
    },
    async (request, reply) => {
      const { email, password, totp, recoveryCode } = request.body as {
        email: string;
        password: string;
        totp?: string;
        recoveryCode?: string;
      };
      const db = getDb();

      if (throttle.isLocked(email)) {
        await recordAuthEvent(db, {
          eventType: "LOGIN_FAILURE",
          metadata: { reason: "rate_limited" },
        });
        throw TOO_MANY_ATTEMPTS;
      }

      const user = await findUserByEmail(db, email);
      const hashToVerify = user?.passwordHash ?? (await getDummyHash(config));
      const passwordValid = await verifyPassword(hashToVerify, password);

      if (!user || !isUsableAccount(user) || !passwordValid) {
        throttle.recordFailure(email);
        await recordAuthEvent(db, {
          eventType: "LOGIN_FAILURE",
          ...(user ? { actorId: user.id } : {}),
          metadata: { reason: !user ? "unknown_user" : !isUsableAccount(user) ? "inactive_user" : "invalid_password" },
        });
        throw INVALID_CREDENTIALS;
      }

      const activeMfa = await findActiveMfaCredential(db, user.id);
      let usedRecoveryCode = false;

      if (activeMfa) {
        if (!totp && !recoveryCode) {
          throw MFA_REQUIRED;
        }

        let mfaValid = false;
        if (totp) {
          const secret = decryptTotpSecret(activeMfa.secretCiphertext, mfaEncryptionKey);
          mfaValid = verifyTotpCode(secret, totp);
        } else if (recoveryCode) {
          mfaValid = await consumeRecoveryCode(db, user.id, recoveryCode);
          usedRecoveryCode = mfaValid;
        }

        if (!mfaValid) {
          throttle.recordFailure(email);
          await recordAuthEvent(db, {
            eventType: "LOGIN_FAILURE",
            actorId: user.id,
            metadata: { reason: totp ? "invalid_mfa" : "invalid_recovery_code" },
          });
          throw INVALID_MFA_CODE;
        }

        await recordAuthEvent(db, { eventType: "MFA_VERIFIED", actorId: user.id });
        if (usedRecoveryCode) {
          await recordAuthEvent(db, { eventType: "RECOVERY_CODE_USED", actorId: user.id });
        }
      }

      throttle.recordSuccess(email);

      const session = await createSession(db, user.id, config);
      reply.setCookie(config.sessionCookieName, session.token, {
        httpOnly: true,
        sameSite: "lax",
        secure: config.cookieSecure,
        path: "/",
        maxAge: config.sessionTtlSeconds,
      });
      setCsrfCookie(reply, generateCsrfToken(), config);

      await recordAuthEvent(db, { eventType: "LOGIN_SUCCESS", actorId: user.id });
      if (user.isBreakGlass) {
        await recordAuthEvent(db, { eventType: "BREAK_GLASS_LOGIN", actorId: user.id });
      }

      return { user: await toAuthenticatedUser(db, user) };
    },
  );

  app.post(
    "/auth/logout",
    { preHandler: authenticate },
    async (request, reply) => {
      requireCsrf(request, config);

      const db = getDb();
      if (request.authSessionId) {
        await revokeSession(db, request.authSessionId);
      }
      if (request.authUser) {
        await recordAuthEvent(db, { eventType: "LOGOUT", actorId: request.authUser.id });
      }

      reply.clearCookie(config.sessionCookieName, { path: "/" });
      reply.clearCookie(config.csrfCookieName, { path: "/" });

      return { success: true };
    },
  );

  app.get("/auth/me", { preHandler: authenticate }, async (request) => {
    return { user: request.authUser };
  });

  app.post(
    "/auth/mfa/enroll",
    { preHandler: authenticate },
    async (request) => {
      requireCsrf(request, config);
      const db = getDb();
      const userId = request.authUser!.id;

      const active = await findActiveMfaCredential(db, userId);
      if (active) {
        throw new AuthError(409, "mfa_already_enabled", "MFA is already enabled for this account.");
      }

      await db.delete(mfaCredentials).where(eq(mfaCredentials.userId, userId));

      const secret = generateTotpSecret();
      const secretCiphertext = encryptTotpSecret(secret, mfaEncryptionKey);
      await db.insert(mfaCredentials).values({ userId, secretCiphertext, status: "pending" });

      return {
        secret,
        otpauthUrl: buildOtpauthUrl(secret, request.authUser!.email, config),
      };
    },
  );

  const enrollConfirmBodySchema = {
    type: "object",
    required: ["totp"],
    properties: { totp: { type: "string", minLength: 6, maxLength: 6 } },
  } as const;

  app.post(
    "/auth/mfa/enroll/confirm",
    { preHandler: authenticate, schema: { body: enrollConfirmBodySchema } },
    async (request) => {
      requireCsrf(request, config);
      const db = getDb();
      const userId = request.authUser!.id;
      const { totp } = request.body as { totp: string };

      const pending = await findPendingMfaCredential(db, userId);
      if (!pending) {
        throw new AuthError(
          404,
          "mfa_enrollment_not_found",
          "No pending MFA enrollment found. Start enrollment again.",
        );
      }

      const secret = decryptTotpSecret(pending.secretCiphertext, mfaEncryptionKey);
      if (!verifyTotpCode(secret, totp)) {
        throw INVALID_MFA_CODE;
      }

      await db
        .update(mfaCredentials)
        .set({ status: "active", confirmedAt: new Date(), updatedAt: new Date() })
        .where(eq(mfaCredentials.id, pending.id));

      const recoveryCodes = await regenerateRecoveryCodes(db, userId);
      await recordAuthEvent(db, { eventType: "MFA_ENROLLED", actorId: userId });

      return { recoveryCodes };
    },
  );

  const passwordConfirmBodySchema = {
    type: "object",
    required: ["password"],
    properties: { password: { type: "string", minLength: 1, maxLength: 512 } },
  } as const;

  app.post(
    "/auth/mfa/disable",
    { preHandler: authenticate, schema: { body: passwordConfirmBodySchema } },
    async (request) => {
      requireCsrf(request, config);
      const db = getDb();
      const userId = request.authUser!.id;
      const { password } = request.body as { password: string };

      const fresh = await findUserById(db, userId);
      if (!fresh?.passwordHash || !(await verifyPassword(fresh.passwordHash, password))) {
        throw INVALID_CREDENTIALS;
      }

      await db.delete(mfaCredentials).where(eq(mfaCredentials.userId, userId));
      await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));

      await recordAuthEvent(db, { eventType: "MFA_DISABLED", actorId: userId });

      return { success: true };
    },
  );

  app.post(
    "/auth/mfa/recovery-codes/regenerate",
    { preHandler: authenticate, schema: { body: passwordConfirmBodySchema } },
    async (request) => {
      requireCsrf(request, config);
      const db = getDb();
      const userId = request.authUser!.id;
      const { password } = request.body as { password: string };

      const fresh = await findUserById(db, userId);
      if (!fresh?.passwordHash || !(await verifyPassword(fresh.passwordHash, password))) {
        throw INVALID_CREDENTIALS;
      }

      const active = await findActiveMfaCredential(db, userId);
      if (!active) {
        throw new AuthError(409, "mfa_not_enabled", "Enable MFA before generating recovery codes.");
      }

      const recoveryCodes = await regenerateRecoveryCodes(db, userId);
      await recordAuthEvent(db, { eventType: "MFA_RECOVERY_CODES_REGENERATED", actorId: userId });

      return { recoveryCodes };
    },
  );
}
