import type { FastifyInstance } from "fastify";
import { getDb } from "@beacon/database";
import type { AppEnv } from "../../config/env.js";
import type { AuthConfig } from "../auth/config.js";
import { createAuthenticateHook } from "../auth/plugin.js";
import { requireCsrf } from "../auth/csrf.js";
import { requirePermission } from "../rbac/guard.js";
import type { NotificationConfig } from "../notifications/config.js";
import { getAdminStatus, getRoleSummaries, revokeUserSessions, resetUserMfa } from "./adminService.js";

interface AdminRoutesOptions {
  env: AppEnv;
  config: AuthConfig;
  notificationConfig: NotificationConfig;
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const userIdParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

/**
 * Application Administration — reuses Module 03's User/RBAC management (no duplicate CRUD here)
 * and adds only what's genuinely new: safe read-only status/role-mapping visibility, and two
 * admin-privileged security actions (session revoke, MFA reset). Never provider-credential
 * administration — that remains Module 27's boundary. See
 * claude/prompts/22-administration.md.
 */
export async function adminRoutes(app: FastifyInstance, opts: AdminRoutesOptions): Promise<void> {
  const { env, config, notificationConfig } = opts;
  const authenticate = createAuthenticateHook(config);
  const canRead = requirePermission("admin.read");
  const canManage = requirePermission("admin.manage");

  app.get("/admin/status", { preHandler: [authenticate, canRead] }, async () => {
    return getAdminStatus(env, config, notificationConfig, getDb());
  });

  app.get("/admin/roles", { preHandler: [authenticate, canRead] }, async () => {
    const items = await getRoleSummaries(getDb());
    return { items };
  });

  app.post(
    "/admin/users/:id/sessions/revoke",
    { preHandler: [authenticate, canManage], schema: { params: userIdParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      await revokeUserSessions(getDb(), id, request.authUser!.id);
      return { success: true };
    },
  );

  app.post(
    "/admin/users/:id/mfa/reset",
    { preHandler: [authenticate, canManage], schema: { params: userIdParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      await resetUserMfa(getDb(), id, request.authUser!.id);
      return { success: true };
    },
  );
}
