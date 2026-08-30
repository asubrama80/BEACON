import { asc, desc, eq, sql } from "drizzle-orm";
import { incidentTimelineEvents, users, type Database, type DbOrTx } from "@beacon/database";
import type { TimelineEventRow } from "./dto.js";

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export function normalizePagination(page?: number, pageSize?: number): { page: number; pageSize: number } {
  const normalizedPage = Number.isInteger(page) && page! > 0 ? page! : 1;
  const normalizedPageSize =
    Number.isInteger(pageSize) && pageSize! > 0 ? Math.min(pageSize!, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  return { page: normalizedPage, pageSize: normalizedPageSize };
}

export interface AppendTimelineEventInput {
  incidentId: string;
  eventType: string;
  /** Omit for a system-generated event. */
  actorUserId?: string;
  metadata?: Record<string, unknown>;
}

/** Append-only — there is deliberately no update/delete function for timeline events. */
export async function appendTimelineEvent(tx: DbOrTx, input: AppendTimelineEventInput): Promise<void> {
  await tx.insert(incidentTimelineEvents).values({
    incidentId: input.incidentId,
    eventType: input.eventType,
    actorUserId: input.actorUserId,
    metadata: input.metadata ?? {},
  });
}

export interface ListTimelineFilter {
  page: number;
  pageSize: number;
  order?: "asc" | "desc" | undefined;
}

export interface ListTimelineResult {
  items: TimelineEventRow[];
  total: number;
}

/** Ordered by (occurredAt, seq) — `seq` is a monotonic tiebreaker so ordering stays deterministic
 * even when two events share the same timestamp, reflecting true insertion order. */
export async function listTimeline(
  db: Database,
  incidentId: string,
  filter: ListTimelineFilter,
): Promise<ListTimelineResult> {
  const whereClause = eq(incidentTimelineEvents.incidentId, incidentId);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(incidentTimelineEvents)
    .where(whereClause);
  const total = countRow?.count ?? 0;

  const orderFn = filter.order === "asc" ? asc : desc;

  const items = await db
    .select({
      id: incidentTimelineEvents.id,
      eventType: incidentTimelineEvents.eventType,
      actorUserId: incidentTimelineEvents.actorUserId,
      actorDisplayName: users.displayName,
      metadata: incidentTimelineEvents.metadata,
      occurredAt: incidentTimelineEvents.occurredAt,
    })
    .from(incidentTimelineEvents)
    .leftJoin(users, eq(users.id, incidentTimelineEvents.actorUserId))
    .where(whereClause)
    .orderBy(orderFn(incidentTimelineEvents.occurredAt), orderFn(incidentTimelineEvents.seq))
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);

  return { items, total };
}
