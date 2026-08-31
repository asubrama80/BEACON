import type { FastifyInstance } from "fastify";
import { getDb } from "@beacon/database";
import type { AuthConfig } from "../auth/config.js";
import { createAuthenticateHook } from "../auth/plugin.js";
import { requireCsrf } from "../auth/csrf.js";
import { requirePermission } from "../rbac/guard.js";
import type { NotificationConfig } from "../notifications/config.js";
import type { GuestInvitationConfig } from "./config.js";
import * as guestInvitationService from "./guestInvitationService.js";

interface GuestInvitationRoutesOptions {
  config: AuthConfig;
  guestInvitationConfig: GuestInvitationConfig;
  notificationConfig: NotificationConfig;
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const incidentIdParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const invitationParamSchema = {
  type: "object",
  required: ["id", "invitationId"],
  properties: {
    id: { type: "string", pattern: UUID_PATTERN },
    invitationId: { type: "string", pattern: UUID_PATTERN },
  },
} as const;

const createInvitationBodySchema = {
  type: "object",
  required: ["guestName"],
  properties: {
    guestName: { type: "string", minLength: 1, maxLength: 255 },
    email: { type: "string", maxLength: 255 },
    mobilePhone: { type: "string", maxLength: 32 },
    capabilities: {
      type: "object",
      properties: { chat: { type: "boolean" }, warRoom: { type: "boolean" } },
    },
  },
} as const;

/**
 * Authenticated guest-invitation management routes — the mirror image of `publicRoutes.ts`'s
 * unauthenticated guest-facing surface. Never exposes a token or token hash in any response body
 * here. See claude/prompts/17-guest-invitations.md, "APIs".
 */
export async function guestInvitationRoutes(app: FastifyInstance, opts: GuestInvitationRoutesOptions): Promise<void> {
  const { config, guestInvitationConfig, notificationConfig } = opts;
  const authenticate = createAuthenticateHook(config);
  const canRead = requirePermission("incidents.guests.read");
  const canInvite = requirePermission("incidents.guests.invite");
  const canRevoke = requirePermission("incidents.guests.revoke");

  app.get(
    "/incidents/:id/guest-invitations",
    { preHandler: [authenticate, canRead], schema: { params: incidentIdParamSchema } },
    async (request) => {
      const { id } = request.params as { id: string };
      const items = await guestInvitationService.listInvitations(getDb(), id);
      return { items };
    },
  );

  app.get(
    "/incidents/:id/guest-invitations/:invitationId",
    { preHandler: [authenticate, canRead], schema: { params: invitationParamSchema } },
    async (request) => {
      const { id, invitationId } = request.params as { id: string; invitationId: string };
      return guestInvitationService.getInvitation(getDb(), id, invitationId);
    },
  );

  app.post(
    "/incidents/:id/guest-invitations",
    { preHandler: [authenticate, canInvite], schema: { params: incidentIdParamSchema, body: createInvitationBodySchema } },
    async (request, reply) => {
      requireCsrf(request, config);
      const { id } = request.params as { id: string };
      const body = request.body as { guestName: string; email?: string; mobilePhone?: string; capabilities?: { chat?: boolean; warRoom?: boolean } };
      const result = await guestInvitationService.createInvitation(getDb(), guestInvitationConfig, notificationConfig, {
        incidentId: id,
        guestName: body.guestName,
        email: body.email ?? null,
        mobilePhone: body.mobilePhone ?? null,
        capabilities: { chat: body.capabilities?.chat === true, warRoom: body.capabilities?.warRoom === true },
        invitedBy: request.authUser!.id,
      });
      reply.status(201);
      return result;
    },
  );

  app.post(
    "/incidents/:id/guest-invitations/:invitationId/revoke",
    { preHandler: [authenticate, canRevoke], schema: { params: invitationParamSchema } },
    async (request) => {
      requireCsrf(request, config);
      const { id, invitationId } = request.params as { id: string; invitationId: string };
      return guestInvitationService.revokeInvitation(getDb(), id, invitationId, request.authUser!.id);
    },
  );
}
