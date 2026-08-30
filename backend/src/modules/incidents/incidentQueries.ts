import { and, eq, desc, ilike, or, sql } from "drizzle-orm";
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
