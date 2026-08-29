import type { FastifyInstance } from "fastify";
import { getDb, roles, permissions } from "@beacon/database";
import type { AuthConfig } from "../auth/config.js";
import { createAuthenticateHook } from "../auth/plugin.js";
import { requirePermission } from "./guard.js";

interface RbacRoutesOptions {
  config: AuthConfig;
}

/**
 * Read-only role/permission listing for administration and frontend rendering. The five
 * system roles and Module 03's permission set are fixed and seed-managed (see
 * `database/src/seed.ts`) — there is deliberately no endpoint here to create custom roles or
 * edit role-permission mappings at runtime, keeping platform recoverability simple to reason
 * about. See `claude/prompts/03-users-rbac.md` for the rationale.
 */
export async function rbacRoutes(app: FastifyInstance, opts: RbacRoutesOptions): Promise<void> {
  const { config } = opts;
  const authenticate = createAuthenticateHook(config);

  app.get("/roles", { preHandler: [authenticate, requirePermission("roles.read")] }, async () => {
    const rows = await getDb()
      .select({ id: roles.id, code: roles.code, name: roles.name, description: roles.description })
      .from(roles)
      .orderBy(roles.name);
    return { roles: rows };
  });

  app.get(
    "/permissions",
    { preHandler: [authenticate, requirePermission("permissions.read")] },
    async () => {
      const rows = await getDb()
        .select({
          id: permissions.id,
          code: permissions.code,
          name: permissions.name,
          description: permissions.description,
        })
        .from(permissions)
        .orderBy(permissions.code);
      return { permissions: rows };
    },
  );
}
