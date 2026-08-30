import { and, eq, sql } from "drizzle-orm";
import { alertRecipients, type Database } from "@beacon/database";
import type { AlertRecipientRow } from "./dto.js";

const RECIPIENT_COLUMNS = {
  id: alertRecipients.id,
  contactId: alertRecipients.contactId,
  recipientName: alertRecipients.recipientName,
  recipientAddress: alertRecipients.recipientAddress,
  channel: alertRecipients.channel,
  renderedSubject: alertRecipients.renderedSubject,
  renderedBody: alertRecipients.renderedBody,
  status: alertRecipients.status,
  provider: alertRecipients.provider,
  providerMessageId: alertRecipients.providerMessageId,
  attemptCount: alertRecipients.attemptCount,
  lastFailureClass: alertRecipients.lastFailureClass,
  lastErrorCode: alertRecipients.lastErrorCode,
  lastErrorSummary: alertRecipients.lastErrorSummary,
  submittedAt: alertRecipients.submittedAt,
  failedAt: alertRecipients.failedAt,
  deliveryStatus: alertRecipients.deliveryStatus,
  deliveryUpdatedAt: alertRecipients.deliveryUpdatedAt,
  deliveredAt: alertRecipients.deliveredAt,
  providerDeliveryCode: alertRecipients.providerDeliveryCode,
  deliveryErrorSummary: alertRecipients.deliveryErrorSummary,
  createdAt: alertRecipients.createdAt,
} as const;

export interface ListAlertRecipientsFilter {
  page: number;
  pageSize: number;
}

export interface ListAlertRecipientsResult {
  items: AlertRecipientRow[];
  total: number;
}

export async function listAlertRecipients(
  db: Database,
  alertId: string,
  filter: ListAlertRecipientsFilter,
): Promise<ListAlertRecipientsResult> {
  const whereClause = eq(alertRecipients.alertId, alertId);

  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(alertRecipients).where(whereClause);
  const total = countRow?.count ?? 0;

  const items = await db
    .select(RECIPIENT_COLUMNS)
    .from(alertRecipients)
    .where(whereClause)
    .orderBy(alertRecipients.recipientName)
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);

  return { items, total };
}

/** Scoped to a specific Alert — never returns a recipient belonging to a different Alert. */
export async function findRecipientRow(db: Database, alertId: string, recipientId: string): Promise<AlertRecipientRow | undefined> {
  const [row] = await db
    .select(RECIPIENT_COLUMNS)
    .from(alertRecipients)
    .where(and(eq(alertRecipients.alertId, alertId), eq(alertRecipients.id, recipientId)))
    .limit(1);
  return row;
}
