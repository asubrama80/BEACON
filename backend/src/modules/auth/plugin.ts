import type { FastifyRequest } from "fastify";
import { getDb } from "@beacon/database";
import type { AuthConfig } from "./config.js";
import { findActiveSessionByToken } from "./session.js";
import { findUserById, isUsableAccount, toAuthenticatedUser } from "./userAuth.js";
import { NOT_AUTHENTICATED } from "./errors.js";

/**
 * Reusable authentication preHandler for protected routes: validates the session cookie,
 * loads the user, rejects expired/revoked sessions and disabled/deleted users, and exposes
 * a safe authenticated-user context on the request. Does not evaluate any RBAC permissions
 * (that's Module 03) — it only answers "is this a valid, currently-usable logged-in user?".
 */
export function createAuthenticateHook(config: AuthConfig) {
  return async function authenticate(request: FastifyRequest): Promise<void> {
    const token = request.cookies[config.sessionCookieName];
    if (!token) {
      throw NOT_AUTHENTICATED;
    }

    const db = getDb();
    const session = await findActiveSessionByToken(db, token);
    if (!session) {
      throw NOT_AUTHENTICATED;
    }

    const user = await findUserById(db, session.userId);
    if (!user || !isUsableAccount(user)) {
      throw NOT_AUTHENTICATED;
    }

    request.authUser = await toAuthenticatedUser(db, user);
    request.authSessionId = session.id;
  };
}
