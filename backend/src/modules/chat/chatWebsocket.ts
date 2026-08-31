import type { FastifyRequest } from "fastify";
import type WebSocket from "ws";
import { getDb } from "@beacon/database";
import { hasPermission } from "../rbac/permissions.js";
import { findIncidentById } from "../incidents/incidentQueries.js";
import { sendMessage, sendGuestMessage } from "./chatService.js";
import { AuthError } from "../auth/errors.js";
import type { ChatMessageDto } from "./chatDto.js";

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

interface ChatActor {
  /** Re-checked per message, not just at connection time — a caller with only read access may
   * hold an open connection but must never be able to persist a message. */
  canSend(): Promise<boolean>;
  send(incidentId: string, body: string): Promise<ChatMessageDto>;
}

async function runConnection(socket: WebSocket, incidentId: string, actor: ChatActor): Promise<void> {
  const db = getDb();
  const incident = await findIncidentById(db, incidentId);
  if (!incident) {
    socket.close(4404, "incident_not_found");
    return;
  }

  registerConnection(incidentId, socket);
  safeSend(socket, { type: "connected", incidentId });

  const sendTimestamps: number[] = [];

  async function handleFrame(raw: Buffer): Promise<void> {
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

    if (!(await actor.canSend())) {
      safeSend(socket, { type: "error", error: "not_authorized", requestId });
      return;
    }

    sendTimestamps.push(now);

    try {
      const message = await actor.send(incidentId, parsed.body);
      safeSend(socket, { type: "sent", requestId, message });
      broadcast(incidentId, { type: "message", message }, socket);
    } catch (err) {
      const safeMessage = err instanceof AuthError ? err.message : "Unable to send message.";
      safeSend(socket, { type: "error", error: "send_failed", message: safeMessage, requestId });
    }
  }

  // Module 24 — frames must be processed strictly in the order they're received. The previous
  // implementation ran each frame's handler as its own independent async IIFE with no
  // serialization: two rapid sends on the same connection could have their `canSend()`/`send()`
  // DB calls interleave and complete out of order, persisting (and broadcasting) messages in a
  // different order than the client sent them. Chaining onto a single per-connection promise
  // forces strict FIFO processing — the next frame never starts until the previous one's full
  // handling (including its DB writes) has settled. See
  // claude/prompts/24-testing.md, "WebSocket message ordering".
  let processingChain: Promise<void> = Promise.resolve();
  socket.on("message", (raw: Buffer) => {
    // `.catch()` on each link (not just the end of the chain) keeps the chain itself always
    // resolved — an unexpected error handling one frame must never silently stop every later
    // frame on this connection from being processed.
    processingChain = processingChain.then(() => handleFrame(raw)).catch(() => {});
  });

  socket.on("close", () => {
    unregisterConnection(incidentId, socket);
  });
}

/**
 * `GET /ws/incidents/:id/chat` connection handler. Authentication and the `incidents.chat.read`
 * permission are already enforced by the route's normal `preHandler` chain (Fastify runs those
 * before the WebSocket upgrade completes — an unauthenticated or unauthorized request never
 * reaches this handler at all, and never gets upgraded). See
 * claude/prompts/13-realtime-incident-chat.md, "WebSocket authentication" and "authorization".
 */
export function createChatConnectionHandler() {
  return async function handleChatConnection(socket: WebSocket, request: FastifyRequest): Promise<void> {
    const { id: incidentId } = request.params as { id: string };
    const userId = request.authUser!.id;
    const db = getDb();

    await runConnection(socket, incidentId, {
      canSend: () => hasPermission(db, userId, "incidents.chat.send"),
      send: (id, body) => sendMessage(db, id, userId, body),
    });
  };
}

/**
 * Module 19 — `GET /ws/guest/incidents/:id/chat`. The route's own `preHandler` chain
 * (`authenticateGuest` + `requireGuestIncidentMatch` + `requireGuestCapability("chat")`) already
 * guarantees a valid Guest session scoped to exactly this Incident with chat granted before the
 * upgrade completes — mirrored here only for defense in depth (`canSend` re-checks the capability
 * per message, exactly like the registered-User handler re-checks `incidents.chat.send`).
 */
export function createGuestChatConnectionHandler() {
  return async function handleGuestChatConnection(socket: WebSocket, request: FastifyRequest): Promise<void> {
    const { id: incidentId } = request.params as { id: string };
    const guest = request.authGuest!;
    const db = getDb();

    await runConnection(socket, incidentId, {
      canSend: () => Promise.resolve(guest.capabilities.chat === true && !!guest.participantId),
      send: (id, body) => sendGuestMessage(db, id, guest.participantId!, body),
    });
  };
}
