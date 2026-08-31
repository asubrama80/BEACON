import type { Database } from "@beacon/database";
import { AuthError } from "../auth/errors.js";
import { listAuditEvents } from "./auditQueries.js";
import { toAuditEventDto, decodeAuditCursor, encodeAuditCursor, type AuditEventDto } from "./auditDto.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const VALID_ACTOR_TYPES = new Set(["user", "guest", "contact", "system"]);
const MAX_FILTER_STRING_LENGTH = 128;

export interface AuditSearchInput {
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
}

export interface AuditSearchResult {
  items: AuditEventDto[];
  nextCursor: string | null;
}

function parseDate(value: string, fieldName: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AuthError(400, "invalid_request", `${fieldName} must be a valid date/time.`);
  }
  return parsed;
}

function validateFilterString(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FILTER_STRING_LENGTH) {
    throw new AuthError(400, "invalid_request", `${fieldName} is invalid.`);
  }
  return trimmed;
}

/**
 * The single authorized entry point for Audit search — validates every filter server-side
 * (no arbitrary/SQL-like query syntax is ever accepted) and returns only the safe DTO shape.
 * Authorization (`audit.read`) is enforced by the route, not here — mirrors every other
 * service function in this codebase. See claude/prompts/20-audit.md, "Query/filter API".
 */
export async function searchAuditEvents(db: Database, input: AuditSearchInput): Promise<AuditSearchResult> {
  const limit = Number.isInteger(input.limit) && input.limit! > 0 ? Math.min(input.limit!, MAX_LIMIT) : DEFAULT_LIMIT;

  const from = input.from ? parseDate(input.from, "from") : undefined;
  const to = input.to ? parseDate(input.to, "to") : undefined;
  if (from && to && from.getTime() > to.getTime()) {
    throw new AuthError(400, "invalid_request", "from must not be after to.");
  }

  if (input.actorType && !VALID_ACTOR_TYPES.has(input.actorType)) {
    throw new AuthError(400, "invalid_request", "actorType must be one of user, guest, contact, system.");
  }

  const cursor = input.cursor ? decodeAuditCursor(input.cursor) : undefined;
  if (input.cursor && !cursor) {
    throw new AuthError(400, "invalid_request", "cursor is malformed.");
  }

  const { items, hasMore } = await listAuditEvents(db, {
    eventType: input.eventType ? validateFilterString(input.eventType, "eventType") : undefined,
    actorType: input.actorType,
    actorId: input.actorId ? validateFilterString(input.actorId, "actorId") : undefined,
    resourceType: input.resourceType ? validateFilterString(input.resourceType, "resourceType") : undefined,
    resourceId: input.resourceId ? validateFilterString(input.resourceId, "resourceId") : undefined,
    incidentId: input.incidentId ? validateFilterString(input.incidentId, "incidentId") : undefined,
    from,
    to,
    cursor,
    limit,
  });

  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id }) : null;

  return { items: items.map(toAuditEventDto), nextCursor };
}
