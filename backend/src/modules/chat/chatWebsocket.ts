import type { FastifyRequest } from "fastify";
import type WebSocket from "ws";
import { getDb } from "@beacon/database";
import { hasPermission } from "../rbac/permissions.js";
import { findIncidentById } from "../incidents/incidentQueries.js";
import { sendMessage } from "./chatService.js";
import { AuthError } from "../auth/errors.js";

/** `ws`'s numeric readyState constants — hardcoded to avoid a value import of the `ws` module in
 * a codebase that otherwise only needs its types (1 === WebSocket.OPEN). */
const WS_OPEN = 1;

/**
 * Process-local incident-scoped connection registry — BEACON currently runs as a single-process
 * modular monolith, so an in-memory `Map` is sufficient. A multi-instance deployment would need a
 * pub/sub layer (e.g. Redis) to fan a broadcast out across processes — a documented scaling
 * limitation, deliberately not built here. See claude/prompts/13-realtime-incident-chat.md,
 * "Single-process limitation".
 */
const connectionsByIncident = new Map<string, Set<WebSocket>>();

const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_SENDS = 15;
/** Skip broadcasting to a socket whose outbound buffer is already this large rather than piling
 * on more data behind a slow/dead client — a lightweight backpressure guard, not a full queue. */
const MAX_BUFFERED_BYTES = 1_000_000;

function registerConnection(incidentId: string, socket: WebSocket): void {
  let set = connectionsByIncident.get(incidentId);
  if (!set) {
    set = new Set();
    connectionsByIncident.set(incidentId, set);
  }
  set.add(socket);
}

function unregisterConnection(incidentId: string, socket: WebSocket): void {
  const set = connectionsByIncident.get(incidentId);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) {
    connectionsByIncident.delete(incidentId);
  }
}

function safeSend(socket: WebSocket, payload: unknown): void {
  if (socket.readyState !== WS_OPEN) return;
  socket.send(JSON.stringify(payload));
}

/**
 * Broadcasts to every other connection on the Incident — deliberately excludes `exclude` (the
 * sender's own socket). The sender already gets the full persisted message via its "sent" ack, so
 * echoing it again here would double-deliver the same message down one connection: once as the
 * ack, once as the broadcast.
 */
function broadcast(incidentId: string, payload: unknown, exclude: WebSocket): void {
  const set = connectionsByIncident.get(incidentId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const client of set) {
    if (client === exclude) continue;
    if (client.readyState !== WS_OPEN) continue;
    if (client.bufferedAmount > MAX_BUFFERED_BYTES) continue;
    client.send(data);
  }
}

/** Test-only observability hook — the number of currently-registered sockets for an Incident. */
export function connectionCountForIncident(incidentId: string): number {
  return connectionsByIncident.get(incidentId)?.size ?? 0;
}

interface IncomingSendFrame {
  type: "send";
  body: string;
  requestId?: string;
}

const INCOMING_SEND_KEYS = new Set(["type", "body", "requestId"]);

/** Strict schema check — rejects unknown commands, missing fields, and unexpected extra keys. */
function isIncomingSendFrame(value: unknown): value is IncomingSendFrame {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "send") return false;
  if (typeof record.body !== "string") return false;
  if (record.requestId !== undefined && typeof record.requestId !== "string") return false;
  return Object.keys(record).every((key) => INCOMING_SEND_KEYS.has(key));
}

/**
 * `GET /ws/incidents/:id/chat` connection handler. Authentication and the `incidents.chat.read`
 * permission are already enforced by the route's normal `preHandler` chain (Fastify runs those
 * before the WebSocket upgrade completes — an unauthenticated or unauthorized request never
 * reaches this handler at all, and never gets upgraded). This handler only adds what the
 * preHandler chain cannot: confirming the Incident actually exists, and re-checking
 * `incidents.chat.send` per message (a caller with only read access may hold an open connection
 * but must never be able to persist a message). See
 * claude/prompts/13-realtime-incident-chat.md, "WebSocket authentication" and "authorization".
 */
export function createChatConnectionHandler() {
  return async function handleChatConnection(socket: WebSocket, request: FastifyRequest): Promise<void> {
    const { id: incidentId } = request.params as { id: string };
    const userId = request.authUser!.id;
    const db = getDb();

    const incident = await findIncidentById(db, incidentId);
    if (!incident) {
      socket.close(4404, "incident_not_found");
      return;
    }

    registerConnection(incidentId, socket);
    safeSend(socket, { type: "connected", incidentId });

    const sendTimestamps: number[] = [];

    socket.on("message", (raw: Buffer) => {
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          safeSend(socket, { type: "error", error: "invalid_payload" });
          return;
        }

        if (!isIncomingSendFrame(parsed)) {
          safeSend(socket, { type: "error", error: "unknown_command" });
          return;
        }
        const requestId = parsed.requestId;

        const now = Date.now();
        while (sendTimestamps.length > 0 && now - sendTimestamps[0]! > RATE_LIMIT_WINDOW_MS) {
          sendTimestamps.shift();
        }
        if (sendTimestamps.length >= RATE_LIMIT_MAX_SENDS) {
          safeSend(socket, { type: "error", error: "rate_limited", requestId });
          return;
        }

        const canSend = await hasPermission(db, userId, "incidents.chat.send");
        if (!canSend) {
          safeSend(socket, { type: "error", error: "not_authorized", requestId });
          return;
        }

        sendTimestamps.push(now);

        try {
          const message = await sendMessage(db, incidentId, userId, parsed.body);
          safeSend(socket, { type: "sent", requestId, message });
          broadcast(incidentId, { type: "message", message }, socket);
        } catch (err) {
          const safeMessage = err instanceof AuthError ? err.message : "Unable to send message.";
          safeSend(socket, { type: "error", error: "send_failed", message: safeMessage, requestId });
        }
      })();
    });

    socket.on("close", () => {
      unregisterConnection(incidentId, socket);
    });
  };
}
