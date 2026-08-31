import type { FastifyInstance } from "fastify";
import { getDb } from "@beacon/database";
import type { AuthConfig } from "../auth/config.js";
import { createAuthenticateHook } from "../auth/plugin.js";
import { requirePermission } from "../rbac/guard.js";
import { getDashboard } from "./dashboardService.js";

interface DashboardRoutesOptions {
  config: AuthConfig;
}

/**
 * A single bounded aggregate endpoint over existing authoritative data — see
 * claude/prompts/21-dashboard-history.md, "Dashboard architecture". Gated on `incidents.read`
 * (held by every current system role) rather than a new permission — preserves the broad
 * visibility this view already had as the authenticated-shell default, without granting anything
 * a role didn't already have.
 */
export async function dashboardRoutes(app: FastifyInstance, opts: DashboardRoutesOptions): Promise<void> {
  const { config } = opts;
  const authenticate = createAuthenticateHook(config);
  const canRead = requirePermission("incidents.read");

  app.get("/dashboard", { preHandler: [authenticate, canRead] }, async () => {
    return getDashboard(getDb());
  });
}
