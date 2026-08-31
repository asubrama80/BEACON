import type { FastifyInstance, FastifyRequest } from "fastify";
import { getDb } from "@beacon/database";
import type { AuthConfig } from "../auth/config.js";
import { createAuthenticateHook } from "../auth/plugin.js";
import { requirePermission } from "../rbac/guard.js";
import { NOT_AUTHORIZED } from "../auth/errors.js";
import type { GuestVerificationConfig } from "../guestVerification/config.js";
import { createAuthenticateGuestHook, requireGuestCapability, requireGuestIncidentMatch } from "../guestVerification/guestAuth.js";
import { createChatConnectionHandler, createGuestChatConnectionHandler } from "./chatWebsocket.js";
import { listMessages } from "./chatService.js";

interface ChatRoutesOptions {
  config: AuthConfig;
  guestVerificationConfig: GuestVerificationConfig;
  /** The single allowed browser origin — reused from the app's own CORS config (Module 13 has no
   * separate origin setting; WebSocket upgrades are validated against the same value). */
  corsOrigin: string;
}

const UUID_PATTERN = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";

const idParamSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", pattern: UUID_PATTERN } },
} as const;

const historyQuerySchema = {
  type: "object",
  properties: {
    before: { type: "integer", minimum: 1 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
  },
} as const;

export async function chatRoutes(app: FastifyInstance, opts: ChatRoutesOptions): Promise<void> {
  const { config, guestVerificationConfig, corsOrigin } = opts;
  const authenticate = createAuthenticateHook(config);
  const canRead = requirePermission("incidents.chat.read");
  const authenticateGuest = createAuthenticateGuestHook(guestVerificationConfig);
  const canGuestChat = requireGuestCapability("chat");

  /**
   * Validates the WebSocket handshake's Origin header against the single configured allowed
   * origin, before the connection is authenticated or upgraded. WebSocket handshakes are not
   * covered by normal CORS preflight/enforcement, and a browser will happily let any page open a
   * cross-origin WebSocket with the victim's cookies attached — Origin validation here is what
   * actually prevents a hostile page from opening an authenticated connection to this endpoint
   * (the WebSocket equivalent of CSRF protection). See
   * claude/prompts/13-realtime-incident-chat.md, "WebSocket CSRF / Origin".
   */
  async function verifyOrigin(request: FastifyRequest): Promise<void> {
    const origin = request.headers.origin;
    if (!origin || origin !== corsOrigin) {
      throw NOT_AUTHORIZED;
    }
  }

  app.get(
    "/ws/incidents/:id/chat",
    {
      websocket: true,
      preHandler: [verifyOrigin, authenticate, canRead],
      schema: { params: idParamSchema },
    },
    createChatConnectionHandler(),
  );

  // Cursor-based REST history — never loads an Incident's entire chat history into one response.
  app.get(
    "/incidents/:id/chat/messages",
    { preHandler: [authenticate, canRead], schema: { params: idParamSchema, querystring: historyQuerySchema } },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as { before?: number; limit?: number };
      return listMessages(getDb(), id, { beforeSeq: query.before, limit: query.limit });
    },
  );

  /**
   * Module 19 — Guest-facing chat. `requireGuestIncidentMatch` (before `canGuestChat`) rejects any
   * attempt to open a connection or send against an Incident other than the one the Guest's own
   * invitation belongs to — the frontend can never widen a Guest's scope by supplying a different
   * `:id`. History reads only require a valid Guest session scoped to this Incident (not the chat
   * capability specifically) — a Guest denied `chat` can still see why they can't participate, the
   * same way a registered read-only User can.
   */
  app.get(
    "/ws/guest/incidents/:id/chat",
    {
      websocket: true,
      preHandler: [verifyOrigin, authenticateGuest, requireGuestIncidentMatch, canGuestChat],
      schema: { params: idParamSchema },
    },
    createGuestChatConnectionHandler(),
  );

  app.get(
    "/guest/incidents/:id/chat/messages",
    { preHandler: [authenticateGuest, requireGuestIncidentMatch], schema: { params: idParamSchema, querystring: historyQuerySchema } },
    async (request) => {
      const { id } = request.params as { id: string };
      const query = request.query as { before?: number; limit?: number };
      return listMessages(getDb(), id, { beforeSeq: query.before, limit: query.limit });
    },
  );
}
