import type { FastifyInstance } from "fastify";
import { getDb } from "@beacon/database";
import type { AuthConfig } from "../auth/config.js";
import { createAuthenticateHook } from "../auth/plugin.js";
import { requirePermission } from "../rbac/guard.js";
import { searchAuditEvents } from "./auditService.js";

interface AuditRoutesOptions {
  config: AuthConfig;
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const auditQuerySchema = {
  type: "object",
  properties: {
    eventType: { type: "string", maxLength: 128 },
    actorType: { type: "string", maxLength: 16 },
    actorId: { type: "string", pattern: UUID_PATTERN },
    resourceType: { type: "string", maxLength: 128 },
    resourceId: { type: "string", pattern: UUID_PATTERN },
    incidentId: { type: "string", pattern: UUID_PATTERN },
    from: { type: "string" },
    to: { type: "string" },
    cursor: { type: "string", maxLength: 512 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

/**
 * Platform-wide Audit search — a single bounded, filtered, keyset-paginated endpoint. Never
 * returns the full table; never accepts arbitrary/SQL-like filter syntax. See
 * claude/prompts/20-audit.md, "Query/filter API".
 */
export async function auditRoutes(app: FastifyInstance, opts: AuditRoutesOptions): Promise<void> {
  const { config } = opts;
  const authenticate = createAuthenticateHook(config);
  const canRead = requirePermission("audit.read");

  app.get(
    "/audit",
    { preHandler: [authenticate, canRead], schema: { querystring: auditQuerySchema } },
    async (request) => {
      const query = request.query as {
        eventType?: string;
        actorType?: string;
        actorId?: string;
        resourceType?: string;
        resourceId?: string;
        incidentId?: string;
        from?: string;
        to?: string;
        cursor?: string;
        limit?: number;
      };
      return searchAuditEvents(getDb(), query);
    },
  );
}
