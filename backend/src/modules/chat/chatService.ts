import type { Database } from "@beacon/database";
import { AuthError } from "../auth/errors.js";
import { findIncidentById } from "../incidents/incidentQueries.js";
import { findParticipantRowById } from "../incidents/participantQueries.js";
import { insertMessage, findMessageById, listMessages as queryMessages, normalizeLimit } from "./chatQueries.js";
import { toChatMessageDto, type ChatMessageDto } from "./chatDto.js";

export const MAX_MESSAGE_LENGTH = 4000;

async function assertIncidentOpenForChat(db: Database, incidentId: string): Promise<void> {
  const incident = await findIncidentById(db, incidentId);
  if (!incident) {
    throw new AuthError(404, "not_found", "Incident not found.");
  }
  if (incident.status === "closed") {
    throw new AuthError(409, "incident_closed", "This Incident is closed; new chat messages can no longer be sent.");
  }
}

function validateBody(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new AuthError(400, "invalid_request", "Message body cannot be empty.");
  }
  if (trimmed.length > MAX_MESSAGE_LENGTH) {
    throw new AuthError(400, "invalid_request", `Message body must be ${MAX_MESSAGE_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

/**
 * Shared by both the WebSocket send handler and (if ever needed) a REST fallback — there is
 * exactly one message-persistence code path. Validates length/non-blank content and the
 * CLOSED-Incident send restriction; never trusts a client-supplied id/seq/timestamp/author.
 * See claude/prompts/13-realtime-incident-chat.md, "CLOSED Incident chat" and "Message limits".
 */
export async function sendMessage(db: Database, incidentId: string, userId: string, rawText: string): Promise<ChatMessageDto> {
  const trimmed = validateBody(rawText);
  await assertIncidentOpenForChat(db, incidentId);

  const { id } = await insertMessage(db, { incidentId, authorType: "user", userId, messageText: trimmed });
  const row = await findMessageById(db, id);
  if (!row) {
    throw new Error("Chat message vanished immediately after insert.");
  }
  return toChatMessageDto(row);
}

/**
 * Module 19 — the Guest equivalent of `sendMessage()`. Authorship goes through `participantId`
 * (the Guest's `incident_participants` row), never a `users` row — the check constraint on
 * `chat_messages` already enforces this at the DB layer. Capability gating
 * (`capabilities.chat === true`) is the caller's responsibility (`requireGuestCapability("chat")`
 * on the route), not re-checked here, mirroring how `sendMessage()` above also leaves permission
 * checking to its own route's `requirePermission()`.
 */
export async function sendGuestMessage(db: Database, incidentId: string, participantId: string, rawText: string): Promise<ChatMessageDto> {
  const trimmed = validateBody(rawText);
  await assertIncidentOpenForChat(db, incidentId);
  // Module 23 — a Guest's WebSocket connection can outlive their removal from the Incident
  // roster (removal revokes the session cookie for *future* handshakes, but doesn't proactively
  // close an already-open socket). Re-checking the participant's current status on every send —
  // not just at connection time — closes that window instead of trusting the connection-time
  // snapshot indefinitely. See claude/prompts/23-security-hardening.md, "Guest chat re-validation".
  const participant = await findParticipantRowById(db, incidentId, participantId);
  if (!participant || participant.status === "removed") {
    throw new AuthError(403, "guest_removed", "This Guest's access to the Incident has been revoked.");
  }

  const { id } = await insertMessage(db, { incidentId, authorType: "guest", participantId, messageText: trimmed });
  const row = await findMessageById(db, id);
  if (!row) {
    throw new Error("Chat message vanished immediately after insert.");
  }
  return toChatMessageDto(row);
}

export interface ListMessagesOptions {
  beforeSeq?: number | undefined;
  limit?: number | undefined;
}

export interface ListMessagesResponse {
  items: ChatMessageDto[];
  hasMore: boolean;
}

/** Cursor-based history — never loads an Incident's entire chat history into one response. */
export async function listMessages(db: Database, incidentId: string, options: ListMessagesOptions): Promise<ListMessagesResponse> {
  const incident = await findIncidentById(db, incidentId);
  if (!incident) {
    throw new AuthError(404, "not_found", "Incident not found.");
  }

  const limit = normalizeLimit(options.limit);
  const rows = await queryMessages(db, incidentId, { beforeSeq: options.beforeSeq, limit: limit + 1 });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(1) : rows; // drop the extra oldest row used only to detect hasMore
  return { items: page.map(toChatMessageDto), hasMore };
}
