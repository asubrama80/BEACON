import { and, desc, eq, gte, lt, lte, or, sql } from "drizzle-orm";
import { auditLogs, users, guestInvitations, type Database } from "@beacon/database";
import type { AuditEventRow, AuditCursor } from "./auditDto.js";

const ROW_COLUMNS = {
  id: auditLogs.id,
  eventType: auditLogs.eventType,
  actorType: auditLogs.actorType,
  actorId: auditLogs.actorId,
  actorUserDisplayName: users.displayName,
  actorGuestName: guestInvitations.guestName,
  resourceType: auditLogs.resourceType,
  resourceId: auditLogs.resourceId,
  incidentId: auditLogs.incidentId,
  metadata: auditLogs.metadata,
  createdAt: auditLogs.createdAt,
} as const;

export interface AuditFilter {
  eventType?: string | undefined;
  actorType?: string | undefined;
  actorId?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  incidentId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  cursor?: AuditCursor | undefined;
  limit: number;
}

export interface AuditPageResult {
  items: AuditEventRow[];
  hasMore: boolean;
}

/**
 * Keyset-paginated, newest-first Audit search. `(created_at, id)` is the stable tiebreaker —
 * `created_at` alone is not a safe sort key under concurrent writes, mirroring the same
 * reasoning `chat_messages.seq`/`incident_timeline_events.seq` already established elsewhere in
 * this codebase (two events can share a millisecond; `id` breaks the tie deterministically).
 */
export async function listAuditEvents(db: Database, filter: AuditFilter): Promise<AuditPageResult> {
  const conditions = [];
  if (filter.eventType) conditions.push(eq(auditLogs.eventType, filter.eventType));
  if (filter.actorType) conditions.push(eq(auditLogs.actorType, filter.actorType));
  if (filter.actorId) conditions.push(eq(auditLogs.actorId, filter.actorId));
  if (filter.resourceType) conditions.push(eq(auditLogs.resourceType, filter.resourceType));
  if (filter.resourceId) conditions.push(eq(auditLogs.resourceId, filter.resourceId));
  if (filter.incidentId) conditions.push(eq(auditLogs.incidentId, filter.incidentId));
  if (filter.from) conditions.push(gte(auditLogs.createdAt, filter.from));
  if (filter.to) conditions.push(lte(auditLogs.createdAt, filter.to));
  if (filter.cursor) {
    // Strictly older than the cursor row: same timestamp with a smaller id, or an earlier timestamp.
    conditions.push(
      or(
        lt(auditLogs.createdAt, filter.cursor.createdAt),
        and(eq(auditLogs.createdAt, filter.cursor.createdAt), lt(auditLogs.id, filter.cursor.id)),
      ),
    );
  }
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const rows = await db
    .select(ROW_COLUMNS)
    .from(auditLogs)
    .leftJoin(users, and(eq(users.id, auditLogs.actorId), eq(auditLogs.actorType, "user")))
    .leftJoin(guestInvitations, and(eq(guestInvitations.id, auditLogs.actorId), eq(auditLogs.actorType, "guest")))
    .where(whereClause)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    // Fetch one extra row to detect "more remain" without a second COUNT query.
    .limit(filter.limit + 1);

  const hasMore = rows.length > filter.limit;
  return { items: hasMore ? rows.slice(0, filter.limit) : rows, hasMore };
}

/** Test/debug-only convenience — never exposed via the API. */
export async function countAuditEvents(db: Database): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(auditLogs);
  return row?.count ?? 0;
}
