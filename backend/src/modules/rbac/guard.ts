import type { FastifyRequest } from "fastify";
import { getDb, type Module03PermissionCode } from "@beacon/database";
import { hasPermission } from "./permissions.js";
import { NOT_AUTHENTICATED, NOT_AUTHORIZED } from "../auth/errors.js";

/**
 * Reusable, permission-based authorization preHandler — the only sanctioned way to gate a
 * route. Always chain it AFTER the `authenticate` preHandler (it deny-by-defaults to 401 if
 * `request.authUser` isn't set, but that shouldn't normally be reachable). Usage:
 *
 *   { preHandler: [authenticate, requirePermission("users.read")] }
 *
 * never:
 *
 *   if (user.role === "ADMIN") { ... }
 */
export function requirePermission(code: Module03PermissionCode) {
  return async function requirePermissionHook(request: FastifyRequest): Promise<void> {
    if (!request.authUser) {
      throw NOT_AUTHENTICATED;
    }

    const db = getDb();
    const allowed = await hasPermission(db, request.authUser.id, code);
    if (!allowed) {
      throw NOT_AUTHORIZED;
    }
  };
}
