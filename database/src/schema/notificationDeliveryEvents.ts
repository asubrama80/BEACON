import { pgTable, uuid, varchar, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { alerts } from "./alerts.js";
import { alertRecipients } from "./alertRecipients.js";

/**
 * Append-only post-submission delivery-status history (Module 11) — one row per distinct
 * provider delivery/bounce/status event. Never holds destination/subject/body/credentials/the
 * raw callback payload; only safe correlation ids, a normalized status, a short safe provider
 * status string, and timestamps. See claude/prompts/11-delivery-tracking.md, "Delivery event
 * history".
 *
 * `dedupe_key` is the idempotency guarantee: `{provider}:event:{providerEventId}` when the
 * provider supplies a native event id, else a deterministic
 * `{provider}:msg:{providerMessageId}:{normalizedStatus}` derived from immutable event
 * attributes — a retried/duplicated callback collapses onto the same key and is a no-op insert.
 */
export const notificationDeliveryEvents = pgTable(
  "notification_delivery_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    alertRecipientId: uuid("alert_recipient_id")
      .notNull()
      .references(() => alertRecipients.id, { onDelete: "cascade" }),
    provider: varchar("provider", { length: 32 }).notNull(),
    providerMessageId: varchar("provider_message_id", { length: 255 }).notNull(),
    providerEventId: varchar("provider_event_id", { length: 255 }),
    dedupeKey: varchar("dedupe_key", { length: 512 }).notNull(),
    /** Safe, short normalized-but-original provider status string, e.g. "delivered", "Bounce". */
    rawProviderStatus: varchar("raw_provider_status", { length: 64 }).notNull(),
    normalizedStatus: varchar("normalized_status", { length: 32 }).notNull(),
    /** Provider-reported event time when present/trustworthy; falls back to received_at. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    /** BEACON ingestion time — always set, independent of provider timestamp trust. */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    providerErrorCode: varchar("provider_error_code", { length: 64 }),
    safeErrorSummary: varchar("safe_error_summary", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("notification_delivery_events_alert_id_idx").on(table.alertId),
    index("notification_delivery_events_recipient_id_idx").on(table.alertRecipientId),
    index("notification_delivery_events_provider_message_id_idx").on(table.provider, table.providerMessageId),
    uniqueIndex("notification_delivery_events_dedupe_key_idx").on(table.dedupeKey),
    check(
      "notification_delivery_events_normalized_status_check",
      sql`${table.normalizedStatus} IN ('submitted', 'pending', 'delivered', 'undelivered', 'bounced', 'failed')`,
    ),
  ],
);
