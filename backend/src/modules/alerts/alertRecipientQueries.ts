import { eq, sql } from "drizzle-orm";
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
