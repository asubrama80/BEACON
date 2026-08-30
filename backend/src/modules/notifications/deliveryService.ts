import type { Database } from "@beacon/database";
import { recordAuthEvent } from "../auth/audit.js";
import { appendTimelineEvent } from "../incidents/timelineQueries.js";
import { findIncidentById } from "../incidents/incidentQueries.js";
import { findAlertById } from "../alerts/alertQueries.js";
import { isDeliveryStatus, isProgression, type NormalizedEventStatus } from "./deliveryStatus.js";
import {
  findRecipientByProviderMessageId,
  insertDeliveryEventIfNew,
  updateRecipientDeliveryState,
  markDeliveryCompletedIfDue,
  getDeliverySummary,
} from "./deliveryQueries.js";

export interface DeliveryEventInput {
  provider: string;
  providerMessageId: string;
  providerEventId?: string | undefined;
  /** Safe, short original provider status string — e.g. "delivered", "Bounce". Never a full payload. */
  rawProviderStatus: string;
  normalizedStatus: NormalizedEventStatus;
  /** Provider-reported event time when present/trustworthy; caller falls back to ingestion time otherwise. */
  occurredAt: Date;
  providerErrorCode?: string | undefined;
  safeErrorSummary?: string | undefined;
}

export type ProcessDeliveryEventOutcome = "processed" | "duplicate" | "unknown_recipient" | "no_op";

/**
 * The single centralized place that turns a provider-neutral delivery event into a state
 * transition — every webhook adapter (Twilio, SES/SNS) and the dev-only mock-simulation path all
 * funnel through this same function, so business logic never lives separately per webhook route.
 * See claude/prompts/11-delivery-tracking.md, "Provider-neutral event service".
 *
 * Never re-resolves a Contact/Group/Template, never re-renders content, never creates a new
 * recipient. Correlation is strictly by (provider, providerMessageId) — see module doc, "Event
 * correlation model".
 */
export async function processDeliveryEvent(db: Database, input: DeliveryEventInput): Promise<ProcessDeliveryEventOutcome> {
  const recipient = await findRecipientByProviderMessageId(db, input.provider, input.providerMessageId);
  if (!recipient) {
    // Section 20: never invent a recipient for an unknown providerMessageId. The caller decides
    // the HTTP response (a safe ack, not a retry-inducing error, for a permanently uncorrelatable
    // callback — see the webhook route handlers).
    return "unknown_recipient";
  }

  const dedupeKey = input.providerEventId
    ? `${input.provider}:event:${input.providerEventId}`
    : `${input.provider}:msg:${input.providerMessageId}:${input.normalizedStatus}`;

  const { inserted } = await insertDeliveryEventIfNew(db, {
    alertId: recipient.alertId,
    alertRecipientId: recipient.id,
    provider: input.provider,
    providerMessageId: input.providerMessageId,
    providerEventId: input.providerEventId,
    dedupeKey,
    rawProviderStatus: input.rawProviderStatus,
    normalizedStatus: input.normalizedStatus,
    occurredAt: input.occurredAt,
    providerErrorCode: input.providerErrorCode,
    safeErrorSummary: input.safeErrorSummary,
  });
  if (!inserted) {
    return "duplicate";
  }

  // "submitted"-type events (Twilio queued/sending/sent) are recorded to history above but never
  // touch delivery_status — that column only ever holds a terminal-or-pending DeliveryStatus.
  if (!isDeliveryStatus(input.normalizedStatus)) {
    return "no_op";
  }

  if (isProgression(recipient.deliveryStatus, input.normalizedStatus)) {
    await updateRecipientDeliveryState(db, recipient.id, input.normalizedStatus, {
      providerErrorCode: input.providerErrorCode,
      safeErrorSummary: input.safeErrorSummary,
    });
  }

  await maybeCompleteDelivery(db, recipient.alertId);

  return "processed";
}

/** Fires ALERT_DELIVERY_COMPLETED exactly once, race-safe — see markDeliveryCompletedIfDue. */
async function maybeCompleteDelivery(db: Database, alertId: string): Promise<void> {
  const justCompleted = await markDeliveryCompletedIfDue(db, alertId);
  if (!justCompleted) return;

  const alert = await findAlertById(db, alertId);
  const counts = await getDeliverySummary(db, alertId);
  const metadata = {
    alertId,
    deliveredCount: counts.delivered,
    failedCount: counts.failed,
    bouncedCount: counts.bounced,
    undeliveredCount: counts.undelivered,
  };

  if (alert?.incidentId) {
    const incident = await findIncidentById(db, alert.incidentId);
    // Delivery callbacks must still be processed for a CLOSED Incident — see module doc, "CLOSED
    // Incident behavior". This only skips the timeline write if the Incident itself no longer
    // exists (should not happen given the FK), never because it's closed.
    if (incident) {
      await appendTimelineEvent(db, {
        incidentId: alert.incidentId,
        eventType: "ALERT_DELIVERY_COMPLETED",
        metadata,
      });
    }
  }

  await recordAuthEvent(db, {
    eventType: "ALERT_DELIVERY_COMPLETED",
    resourceType: "alert",
    resourceId: alertId,
    ...(alert?.incidentId ? { incidentId: alert.incidentId } : {}),
    metadata,
  });
}
