import { and, eq, sql } from "drizzle-orm";
import { alertRecipients, alerts, notificationDeliveryEvents, type Database, type DbOrTx } from "@beacon/database";
import type { DeliveryStatus, NormalizedEventStatus } from "./deliveryStatus.js";

export interface RecipientForDelivery {
  id: string;
  alertId: string;
  channel: string;
  submissionStatus: string;
  deliveryStatus: DeliveryStatus | null;
}

/** Correlation is by (provider, providerMessageId) only — never phone/email/subject/body. */
export async function findRecipientByProviderMessageId(
  db: DbOrTx,
  provider: string,
  providerMessageId: string,
): Promise<RecipientForDelivery | undefined> {
  const [row] = await db
    .select({
      id: alertRecipients.id,
      alertId: alertRecipients.alertId,
      channel: alertRecipients.channel,
      submissionStatus: alertRecipients.status,
      deliveryStatus: alertRecipients.deliveryStatus,
    })
    .from(alertRecipients)
    .where(and(eq(alertRecipients.provider, provider), eq(alertRecipients.providerMessageId, providerMessageId)))
    .limit(1);
  if (!row) return undefined;
  return { ...row, deliveryStatus: row.deliveryStatus as DeliveryStatus | null };
}

export interface InsertDeliveryEventInput {
  alertId: string;
  alertRecipientId: string;
  provider: string;
  providerMessageId: string;
  providerEventId?: string | undefined;
  dedupeKey: string;
  rawProviderStatus: string;
  normalizedStatus: NormalizedEventStatus;
  occurredAt: Date;
  providerErrorCode?: string | undefined;
  safeErrorSummary?: string | undefined;
}

/**
 * Idempotency guarantee: `dedupeKey` carries a unique index; a retried/duplicated provider
 * callback collapses onto the same key and inserts zero rows the second time. See
 * claude/prompts/11-delivery-tracking.md, "Duplicate event handling".
 */
export async function insertDeliveryEventIfNew(db: DbOrTx, input: InsertDeliveryEventInput): Promise<{ inserted: boolean }> {
  const result = await db
    .insert(notificationDeliveryEvents)
    .values({
      alertId: input.alertId,
      alertRecipientId: input.alertRecipientId,
      provider: input.provider,
      providerMessageId: input.providerMessageId,
      providerEventId: input.providerEventId,
      dedupeKey: input.dedupeKey,
      rawProviderStatus: input.rawProviderStatus,
      normalizedStatus: input.normalizedStatus,
      occurredAt: input.occurredAt,
      providerErrorCode: input.providerErrorCode,
      safeErrorSummary: input.safeErrorSummary,
    })
    .onConflictDoNothing({ target: notificationDeliveryEvents.dedupeKey })
    .returning({ id: notificationDeliveryEvents.id });
  return { inserted: result.length > 0 };
}

export async function updateRecipientDeliveryState(
  db: DbOrTx,
  recipientId: string,
  status: DeliveryStatus,
  detail: { providerErrorCode?: string | undefined; safeErrorSummary?: string | undefined },
): Promise<void> {
  const now = new Date();
  await db
    .update(alertRecipients)
    .set({
      deliveryStatus: status,
      deliveryUpdatedAt: now,
      deliveredAt: status === "delivered" ? now : undefined,
      deliveryFailedAt: status === "undelivered" || status === "bounced" || status === "failed" ? now : undefined,
      providerDeliveryCode: detail.providerErrorCode,
      deliveryErrorSummary: detail.safeErrorSummary,
      updatedAt: now,
    })
    .where(eq(alertRecipients.id, recipientId));
}

/**
 * Atomically marks the Alert's delivery tracking complete — exactly once, race-safe under
 * concurrent event processing. "Complete" means every recipient that was actually submitted to
 * the provider has now reached a terminal delivery state, and at least one such recipient exists.
 * The conditional `WHERE delivery_completed_at IS NULL` is the guard: whichever concurrent call's
 * UPDATE actually flips it from NULL is the one that gets to fire the completion event.
 */
export async function markDeliveryCompletedIfDue(db: Database, alertId: string): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    UPDATE alerts
    SET delivery_completed_at = now(), updated_at = now()
    WHERE id = ${alertId}
      AND delivery_completed_at IS NULL
      AND EXISTS (SELECT 1 FROM alert_recipients WHERE alert_id = ${alertId} AND status = 'submitted')
      AND NOT EXISTS (
        SELECT 1 FROM alert_recipients
        WHERE alert_id = ${alertId} AND status = 'submitted' AND (delivery_status IS NULL OR delivery_status = 'pending')
      )
    RETURNING id
  `);
  return rows.length > 0;
}

export interface DeliverySummaryCounts {
  total: number;
  submissionFailed: number;
  deliveryPending: number;
  delivered: number;
  undelivered: number;
  bounced: number;
  failed: number;
}

export async function getDeliverySummary(db: DbOrTx, alertId: string): Promise<DeliverySummaryCounts> {
  const rows = await db
    .select({ status: alertRecipients.status, deliveryStatus: alertRecipients.deliveryStatus, count: sql<number>`count(*)::int` })
    .from(alertRecipients)
    .where(eq(alertRecipients.alertId, alertId))
    .groupBy(alertRecipients.status, alertRecipients.deliveryStatus);

  const counts: DeliverySummaryCounts = {
    total: 0,
    submissionFailed: 0,
    deliveryPending: 0,
    delivered: 0,
    undelivered: 0,
    bounced: 0,
    failed: 0,
  };
  for (const row of rows) {
    counts.total += row.count;
    if (row.status === "submission_failed") {
      counts.submissionFailed += row.count;
      continue;
    }
    if (row.status !== "submitted") continue;
    if (row.deliveryStatus === "delivered") counts.delivered += row.count;
    else if (row.deliveryStatus === "undelivered") counts.undelivered += row.count;
    else if (row.deliveryStatus === "bounced") counts.bounced += row.count;
    else if (row.deliveryStatus === "failed") counts.failed += row.count;
    else counts.deliveryPending += row.count;
  }
  return counts;
}

/**
 * Same aggregate shape as `getDeliverySummary`, but rolled up across every recipient of every
 * Alert belonging to one Incident — used by Module 12's Command Center. Joins to `alerts` only to
 * scope by `incident_id`; never touches Contact/Group data or destination PII. See
 * claude/prompts/12-incident-command-center.md, "Alert communication summary".
 */
export async function getIncidentDeliverySummary(db: DbOrTx, incidentId: string): Promise<DeliverySummaryCounts> {
  const rows = await db
    .select({ status: alertRecipients.status, deliveryStatus: alertRecipients.deliveryStatus, count: sql<number>`count(*)::int` })
    .from(alertRecipients)
    .innerJoin(alerts, eq(alerts.id, alertRecipients.alertId))
    .where(eq(alerts.incidentId, incidentId))
    .groupBy(alertRecipients.status, alertRecipients.deliveryStatus);

  const counts: DeliverySummaryCounts = {
    total: 0,
    submissionFailed: 0,
    deliveryPending: 0,
    delivered: 0,
    undelivered: 0,
    bounced: 0,
    failed: 0,
  };
  for (const row of rows) {
    counts.total += row.count;
    if (row.status === "submission_failed") {
      counts.submissionFailed += row.count;
      continue;
    }
    if (row.status !== "submitted") continue;
    if (row.deliveryStatus === "delivered") counts.delivered += row.count;
    else if (row.deliveryStatus === "undelivered") counts.undelivered += row.count;
    else if (row.deliveryStatus === "bounced") counts.bounced += row.count;
    else if (row.deliveryStatus === "failed") counts.failed += row.count;
    else counts.deliveryPending += row.count;
  }
  return counts;
}

export interface DeliveryEventRow {
  id: string;
  provider: string;
  providerMessageId: string;
  providerEventId: string | null;
  rawProviderStatus: string;
  normalizedStatus: string;
  occurredAt: Date;
  receivedAt: Date;
  providerErrorCode: string | null;
  safeErrorSummary: string | null;
}

export async function listDeliveryEventsForRecipient(db: Database, alertRecipientId: string): Promise<DeliveryEventRow[]> {
  return db
    .select({
      id: notificationDeliveryEvents.id,
      provider: notificationDeliveryEvents.provider,
      providerMessageId: notificationDeliveryEvents.providerMessageId,
      providerEventId: notificationDeliveryEvents.providerEventId,
      rawProviderStatus: notificationDeliveryEvents.rawProviderStatus,
      normalizedStatus: notificationDeliveryEvents.normalizedStatus,
      occurredAt: notificationDeliveryEvents.occurredAt,
      receivedAt: notificationDeliveryEvents.receivedAt,
      providerErrorCode: notificationDeliveryEvents.providerErrorCode,
      safeErrorSummary: notificationDeliveryEvents.safeErrorSummary,
    })
    .from(notificationDeliveryEvents)
    .where(eq(notificationDeliveryEvents.alertRecipientId, alertRecipientId))
    .orderBy(notificationDeliveryEvents.occurredAt, notificationDeliveryEvents.createdAt);
}
