import { and, eq, desc, ilike, or, sql } from "drizzle-orm";
import {
  alerts,
  alertContactSelections,
  alertGroupSelections,
  contacts,
  groups,
  incidents,
  templates,
  users,
  type Database,
  type DbOrTx,
} from "@beacon/database";
import type { AlertRow, SourceContactRef, SourceGroupRef } from "./dto.js";

const SOURCE_CONTACT_COUNT = sql<number>`(select count(*)::int from ${alertContactSelections} where ${alertContactSelections.alertId} = ${alerts.id})`;
const SOURCE_GROUP_COUNT = sql<number>`(select count(*)::int from ${alertGroupSelections} where ${alertGroupSelections.alertId} = ${alerts.id})`;

const AGGREGATE_COLUMNS = {
  id: alerts.id,
  alertNumber: alerts.alertNumber,
  title: alerts.title,
  incidentId: alerts.incidentId,
  incidentNumber: incidents.incidentNumber,
  incidentTitle: incidents.title,
  incidentStatus: incidents.status,
  templateId: alerts.templateId,
  templateName: templates.name,
  templateStatus: templates.status,
  templateNameSnapshot: alerts.templateNameSnapshot,
  channel: alerts.channel,
  status: alerts.status,
  contentSource: alerts.contentSource,
  subject: alerts.subject,
  body: alerts.body,
  eligibleRecipientCount: alerts.eligibleRecipientCount,
  excludedCount: alerts.excludedCount,
  exclusionSummary: alerts.exclusionSummary,
  createdByDisplayName: users.displayName,
  createdAt: alerts.createdAt,
  updatedAt: alerts.updatedAt,
  readyAt: alerts.readyAt,
  cancelledAt: alerts.cancelledAt,
  sourceContactCount: SOURCE_CONTACT_COUNT,
  sourceGroupCount: SOURCE_GROUP_COUNT,
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
 * Formats a value from the `alert_number_seq` Postgres sequence into "ALT-{year}-{6-digit}" —
 * mirrors `generateIncidentNumber` (Module 08). See claude/prompts/09-alert-engine.md, "Alert
 * identifier strategy".
 */
export async function generateAlertNumber(db: DbOrTx): Promise<string> {
  const rows = await db.execute<{ n: string }>(sql`select nextval('alert_number_seq')::text as n`);
  const n = rows[0]?.n;
  if (!n) {
    throw new Error("Failed to generate an alert number.");
  }
  const year = new Date().getFullYear();
  return `ALT-${year}-${n.padStart(6, "0")}`;
}

export interface ListAlertsFilter {
  search?: string | undefined;
  status?: string | undefined;
  channel?: string | undefined;
  incidentId?: string | undefined;
  page: number;
  pageSize: number;
}

export interface ListAlertsResult {
  items: AlertRow[];
  total: number;
}

export async function listAlerts(db: Database, filter: ListAlertsFilter): Promise<ListAlertsResult> {
  const conditions = [];
  if (filter.search) {
    const pattern = `%${filter.search}%`;
    conditions.push(or(ilike(alerts.alertNumber, pattern), ilike(alerts.title, pattern)));
  }
  if (filter.status) conditions.push(eq(alerts.status, filter.status));
  if (filter.channel) conditions.push(eq(alerts.channel, filter.channel));
  if (filter.incidentId) conditions.push(eq(alerts.incidentId, filter.incidentId));
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(alerts).where(whereClause);
  const total = countRow?.count ?? 0;

  const items = await db
    .select(AGGREGATE_COLUMNS)
    .from(alerts)
    .leftJoin(incidents, eq(incidents.id, alerts.incidentId))
    .leftJoin(templates, eq(templates.id, alerts.templateId))
    .leftJoin(users, eq(users.id, alerts.createdBy))
    .where(whereClause)
    .orderBy(desc(alerts.updatedAt))
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);

  return { items, total };
}

export async function findAlertById(db: DbOrTx, id: string): Promise<AlertRow | undefined> {
  const [row] = await db
    .select(AGGREGATE_COLUMNS)
    .from(alerts)
    .leftJoin(incidents, eq(incidents.id, alerts.incidentId))
    .leftJoin(templates, eq(templates.id, alerts.templateId))
    .leftJoin(users, eq(users.id, alerts.createdBy))
    .where(eq(alerts.id, id))
    .limit(1);
  return row;
}

/** Locks the Alert row for the duration of the enclosing transaction (concurrency guard). */
export async function findAlertForUpdate(
  tx: DbOrTx,
  id: string,
): Promise<{ id: string; status: string; incidentId: string | null; channel: string } | undefined> {
  const [row] = await tx
    .select({ id: alerts.id, status: alerts.status, incidentId: alerts.incidentId, channel: alerts.channel })
    .from(alerts)
    .where(eq(alerts.id, id))
    .for("update")
    .limit(1);
  return row;
}

/** Names only, never phone/email — see module doc, "Recipient PII permission". */
export async function getContactSelectionSummaries(db: DbOrTx, alertId: string): Promise<SourceContactRef[]> {
  const rows = await db
    .select({ id: contacts.id, firstName: contacts.firstName, lastName: contacts.lastName })
    .from(alertContactSelections)
    .innerJoin(contacts, eq(contacts.id, alertContactSelections.contactId))
    .where(eq(alertContactSelections.alertId, alertId));
  return rows.map((r) => ({ id: r.id, displayName: `${r.firstName} ${r.lastName}`.trim() }));
}

export async function getGroupSelectionSummaries(db: DbOrTx, alertId: string): Promise<SourceGroupRef[]> {
  const rows = await db
    .select({ id: groups.id, name: groups.name })
    .from(alertGroupSelections)
    .innerJoin(groups, eq(groups.id, alertGroupSelections.groupId))
    .where(eq(alertGroupSelections.alertId, alertId));
  return rows;
}

export async function getContactSelectionIds(db: DbOrTx, alertId: string): Promise<string[]> {
  const rows = await db
    .select({ contactId: alertContactSelections.contactId })
    .from(alertContactSelections)
    .where(eq(alertContactSelections.alertId, alertId));
  return rows.map((r) => r.contactId);
}

export async function getGroupSelectionIds(db: DbOrTx, alertId: string): Promise<string[]> {
  const rows = await db
    .select({ groupId: alertGroupSelections.groupId })
    .from(alertGroupSelections)
    .where(eq(alertGroupSelections.alertId, alertId));
  return rows.map((r) => r.groupId);
}

export async function replaceContactSelections(tx: DbOrTx, alertId: string, contactIds: string[]): Promise<void> {
  await tx.delete(alertContactSelections).where(eq(alertContactSelections.alertId, alertId));
  if (contactIds.length > 0) {
    await tx.insert(alertContactSelections).values(contactIds.map((contactId) => ({ alertId, contactId })));
  }
}

export async function replaceGroupSelections(tx: DbOrTx, alertId: string, groupIds: string[]): Promise<void> {
  await tx.delete(alertGroupSelections).where(eq(alertGroupSelections.alertId, alertId));
  if (groupIds.length > 0) {
    await tx.insert(alertGroupSelections).values(groupIds.map((groupId) => ({ alertId, groupId })));
  }
}
