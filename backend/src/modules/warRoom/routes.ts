import type { FastifyInstance } from "fastify";
import { getDb } from "@beacon/database";
import type { AuthConfig } from "../auth/config.js";
import { createAuthenticateHook } from "../auth/plugin.js";
import { requireCsrf } from "../auth/csrf.js";
import { requirePermission } from "../rbac/guard.js";
import * as warRoomService from "./warRoomService.js";

interface WarRoomRoutesOptions {
  config: AuthConfig;
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

/**
 * Provider-neutral War Room foundation routes — no meeting URL, no media token, no external
 * network call anywhere in this module. See claude/prompts/14-war-room-foundation.md.
 */
export async function warRoomRoutes(app: FastifyInstance, opts: WarRoomRoutesOptions): Promise<void> {
  const { config } = opts;
  const authenticate = createAuthenticateHook(config);
  const canRead = requirePermission("incidents.war_room.read");
  const canManage = requirePermission("incidents.war_room.manage");
  const canJoin = requirePermission("incidents.war_room.join");

  app.get(
    "/incidents/:id/war-room",
    { preHandler: [authenticate, canRead], schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params as { id: string };
      return warRoomService.getWarRoom(getDb(), id);
    },
  );

  app.get(
    "/incidents/:id/war-room/sessions",
    { preHandler: [authenticate, canRead], schema: { params: idParamSchema } },
    async (request) => {
      const { id } = request.params as { id: string };
      const items = await warRoomService.listWarRoomSessions(getDb(), id);
      return { items };
    },
  );

  app.post(
    "/incidents/:id/war-room/open",
    { preHandler: [authenticate, canManage], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      return warRoomService.openWarRoom(getDb(), id, request.authUser!.id);
    },
  );

  app.post(
    "/incidents/:id/war-room/end",
    { preHandler: [authenticate, canManage], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      return warRoomService.endWarRoom(getDb(), id, request.authUser!.id);
    },
  );

  app.post(
    "/incidents/:id/war-room/join",
    { preHandler: [authenticate, canJoin], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      return warRoomService.joinWarRoom(getDb(), id, request.authUser!.id);
    },
  );

  app.post(
    "/incidents/:id/war-room/leave",
    { preHandler: [authenticate, canJoin], schema: { params: idParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      return warRoomService.leaveWarRoom(getDb(), id, request.authUser!.id);
    },
  );
}
