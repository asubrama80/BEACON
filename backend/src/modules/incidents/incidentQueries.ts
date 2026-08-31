import { and, eq, desc, gte, ilike, lte, or, sql } from "drizzle-orm";
import { incidents, incidentParticipants, users, type Database, type DbOrTx } from "@beacon/database";
import type { IncidentRow } from "./dto.js";

const PARTICIPANT_COUNT = sql<number>`count(${incidentParticipants.id}) filter (where ${incidentParticipants.status} != 'removed')::int`;
const USER_PARTICIPANT_COUNT = sql<number>`count(${incidentParticipants.id}) filter (where ${incidentParticipants.status} != 'removed' and ${incidentParticipants.participantType} = 'user')::int`;
const CONTACT_PARTICIPANT_COUNT = sql<number>`count(${incidentParticipants.id}) filter (where ${incidentParticipants.status} != 'removed' and ${incidentParticipants.participantType} = 'contact')::int`;

const AGGREGATE_COLUMNS = {
  id: incidents.id,
  incidentNumber: incidents.incidentNumber,
  title: incidents.title,
  description: incidents.description,
  severity: incidents.severity,
  status: incidents.status,
  commanderId: users.id,
  commanderDisplayName: users.displayName,
  commanderStatus: users.status,
  activatedAt: incidents.activatedAt,
  resolvedAt: incidents.resolvedAt,
  closedAt: incidents.closedAt,
  createdAt: incidents.createdAt,
  updatedAt: incidents.updatedAt,
  participantCount: PARTICIPANT_COUNT,
  registeredUserCount: USER_PARTICIPANT_COUNT,
  contactParticipantCount: CONTACT_PARTICIPANT_COUNT,
} as const;

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export function normalizePagination(page?: number, pageSize?: number): { page: number; pageSize: number } {
  const normalizedPage = Number.isInteger(page) && page! > 0 ? page! : 1;
  const normalizedPageSize =
    Number.isInteger(pageSize) && pageSize! > 0 ? Math.min(pageSize!, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  return { page: normalizedPage, pageSize: normalizedPageSize };
}

/**
 * Formats a value from the `incident_number_seq` Postgres sequence into the human-readable
 * "INC-{year}-{6-digit}" shape. `nextval()` is lock-free and safe under concurrent inserts —
 * see claude/prompts/08-incident-management.md, "Incident identifier strategy" for why this is
 * a single global counter (never reset per calendar year) rather than a per-year sequence.
 */
export async function generateIncidentNumber(db: DbOrTx): Promise<string> {
  const rows = await db.execute<{ n: string }>(sql`select nextval('incident_number_seq')::text as n`);
  const n = rows[0]?.n;
  if (!n) {
    throw new Error("Failed to generate an incident number.");
  }
  const year = new Date().getFullYear();
  return `INC-${year}-${n.padStart(6, "0")}`;
}

export interface ListIncidentsFilter {
  search?: string | undefined;
  status?: string | undefined;
  severity?: string | undefined;
  commanderId?: string | undefined;
  /** Module 21 — Incident History date-range filter, on `created_at`. */
  from?: Date | undefined;
  to?: Date | undefined;
  page: number;
  pageSize: number;
}

export interface ListIncidentsResult {
  items: IncidentRow[];
  total: number;
}

/** One aggregated query per page (incident + commander + participant counts) — avoids N+1. */
export async function listIncidents(db: Database, filter: ListIncidentsFilter): Promise<ListIncidentsResult> {
  const conditions = [];
  if (filter.search) {
    const pattern = `%${filter.search}%`;
    conditions.push(or(ilike(incidents.incidentNumber, pattern), ilike(incidents.title, pattern)));
  }
  if (filter.status) conditions.push(eq(incidents.status, filter.status));
  if (filter.severity) conditions.push(eq(incidents.severity, filter.severity));
  if (filter.commanderId) conditions.push(eq(incidents.incidentCommanderId, filter.commanderId));
  if (filter.from) conditions.push(gte(incidents.createdAt, filter.from));
  if (filter.to) conditions.push(lte(incidents.createdAt, filter.to));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(incidents).where(whereClause);
  const total = countRow?.count ?? 0;

  const items = await db
    .select(AGGREGATE_COLUMNS)
    .from(incidents)
    .leftJoin(users, eq(users.id, incidents.incidentCommanderId))
    .leftJoin(incidentParticipants, eq(incidentParticipants.incidentId, incidents.id))
    .where(whereClause)
    .groupBy(incidents.id, users.id)
    .orderBy(desc(incidents.updatedAt))
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);

  return { items, total };
}

export interface IncidentStatusCounts {
  total: number;
  open: number;
  active: number;
  resolved: number;
  closed: number;
}

/**
 * Module 21 — Dashboard's global (not one-Incident-scoped) status breakdown, mirroring
 * `alerts/alertQueries.ts`'s `getIncidentAlertStatusCounts` shape exactly: a plain `GROUP BY
 * status` count, never a second incident-status model. See
 * claude/prompts/21-dashboard-history.md, "Metric definitions".
 */
export async function getIncidentStatusCounts(db: DbOrTx): Promise<IncidentStatusCounts> {
  const rows = await db.select({ status: incidents.status, count: sql<number>`count(*)::int` }).from(incidents).groupBy(incidents.status);

  const counts: IncidentStatusCounts = { total: 0, open: 0, active: 0, resolved: 0, closed: 0 };
  for (const row of rows) {
    counts.total += row.count;
    if (row.status === "open") counts.open += row.count;
    else if (row.status === "active") counts.active += row.count;
    else if (row.status === "resolved") counts.resolved += row.count;
    else if (row.status === "closed") counts.closed += row.count;
  }
  return counts;
}

export async function findIncidentById(db: DbOrTx, id: string): Promise<IncidentRow | undefined> {
  const [row] = await db
    .select(AGGREGATE_COLUMNS)
    .from(incidents)
    .leftJoin(users, eq(users.id, incidents.incidentCommanderId))
    .leftJoin(incidentParticipants, eq(incidentParticipants.incidentId, incidents.id))
    .where(eq(incidents.id, id))
    .groupBy(incidents.id, users.id)
    .limit(1);
  return row;
}

/** Locks the Incident row for the duration of the enclosing transaction (concurrency guard). */
export async function findIncidentForUpdate(
  tx: DbOrTx,
  id: string,
): Promise<{ id: string; status: string; incidentCommanderId: string | null } | undefined> {
  const [row] = await tx
    .select({ id: incidents.id, status: incidents.status, incidentCommanderId: incidents.incidentCommanderId })
    .from(incidents)
    .where(eq(incidents.id, id))
    .for("update")
    .limit(1);
  return row;
}
