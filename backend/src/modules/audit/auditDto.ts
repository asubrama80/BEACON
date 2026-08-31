/**
 * Audit answers WHO did WHAT to WHICH resource WHEN, with safe contextual metadata — a
 * platform-wide accountability record, deliberately distinct from an Incident's own timeline
 * (`incident_timeline_events`, Module 08), which answers "what operationally happened during
 * this Incident?". See claude/prompts/20-audit.md, "Audit vs Incident timeline".
 */
export interface AuditActorDto {
  type: "user" | "guest" | "contact" | "system";
  id: string | null;
  /** Resolved at read time (joins `users`/`guest_invitations`) — never stored as a snapshot, so
   * it always reflects the identity's current name. `null` for a system-generated event or an
   * identity that no longer resolves (e.g. a deleted User). */
  displayName: string | null;
}

export interface AuditResourceDto {
  type: string | null;
  id: string | null;
}

export interface AuditEventDto {
  id: string;
  timestamp: string;
  eventType: string;
  actor: AuditActorDto;
  resource: AuditResourceDto;
  incidentId: string | null;
  /** Server-built, allowlisted-at-the-call-site metadata only — never a raw request body, never
   * a secret. See claude/prompts/20-audit.md, "Metadata policy". */
  metadata: Record<string, unknown>;
}

export interface AuditEventRow {
  id: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  actorUserDisplayName: string | null;
  actorGuestName: string | null;
  resourceType: string | null;
  resourceId: string | null;
  incidentId: string | null;
  metadata: unknown;
  createdAt: Date;
}

function resolveActorDisplayName(row: AuditEventRow): string | null {
  if (row.actorType === "user") return row.actorUserDisplayName;
  if (row.actorType === "guest") return row.actorGuestName;
  if (row.actorType === "system") return "System";
  return null;
}

export function toAuditEventDto(row: AuditEventRow): AuditEventDto {
  return {
    id: row.id,
    timestamp: row.createdAt.toISOString(),
    eventType: row.eventType,
    actor: {
      type: row.actorType as AuditActorDto["type"],
      id: row.actorId,
      displayName: resolveActorDisplayName(row),
    },
    resource: { type: row.resourceType, id: row.resourceId },
    incidentId: row.incidentId,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * Opaque keyset-pagination cursor, encoding the last row's `(created_at, id)` tiebreaker pair.
 * Audit is a potentially very large, always-newest-first, append-only table — keyset pagination
 * avoids the ever-growing-OFFSET cost an unbounded audit trail would otherwise accumulate. This
 * is a deliberate, documented deviation from this codebase's usual page/pageSize convention
 * (every other list endpoint) — see claude/prompts/20-audit.md, "Pagination".
 */
export interface AuditCursor {
  createdAt: Date;
  id: string;
}

export function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }), "utf8").toString("base64url");
}

export function decodeAuditCursor(raw: string): AuditCursor | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { createdAt?: unknown; id?: unknown };
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") return undefined;
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return undefined;
    return { createdAt, id: parsed.id };
  } catch {
    return undefined;
  }
}
