import { pgTable, uuid, varchar, text, integer, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { alerts } from "./alerts.js";
import { contacts } from "./contacts.js";

/**
 * Per-recipient snapshot. For Module 09, `contact_id` is always set — Alert recipients resolve
 * only to Contacts (never Users, never Guests; see claude/prompts/09-alert-engine.md, "Recipient
 * source model"). `recipient_address` holds the immutable destination snapshot (normalized phone
 * for SMS / email for EMAIL) captured at READY time — a deliberate PII-duplication exception, see
 * "Destination snapshot rationale" in the module doc. Rows here represent only ELIGIBLE, resolved
 * recipients; excluded candidates are never persisted per-row, only as safe counts on `alerts`.
 *
 * Module 10 adds provider-submission tracking: `status` gains `dispatching`/`submission_failed`
 * (alongside Module 09's `pending_delivery` and the pre-existing `submitted` placeholder);
 * `provider`/`attempt_count`/`last_*` summarize the latest attempt for convenient display, while
 * full attempt history lives in `notification_dispatch_attempts`. `delivered`/`queued` remain
 * unused, reserved for Module 11.
 */
export const alertRecipients = pgTable(
  "alert_recipients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    recipientName: varchar("recipient_name", { length: 255 }),
    recipientAddress: varchar("recipient_address", { length: 255 }),
    /** This recipient's personalized final content — see module doc, "Content snapshot verification". */
    renderedSubject: text("rendered_subject"),
    renderedBody: text("rendered_body"),
    channel: varchar("channel", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("pending_delivery"),
    /** Which provider handled the latest attempt, e.g. "mock" | "twilio" | "ses". */
    provider: varchar("provider", { length: 32 }),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastFailureClass: varchar("last_failure_class", { length: 16 }),
    lastErrorCode: varchar("last_error_code", { length: 64 }),
    lastErrorSummary: varchar("last_error_summary", { length: 255 }),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    errorDetail: text("error_detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("alert_recipients_alert_id_idx").on(table.alertId),
    index("alert_recipients_status_idx").on(table.status),
    index("alert_recipients_provider_message_id_idx").on(table.providerMessageId),
    // One resolved recipient row per (Alert, Contact) — the database-level dedupe guarantee,
    // mirroring incident_participants' partial unique indexes from Module 08.
    uniqueIndex("alert_recipients_alert_contact_idx")
      .on(table.alertId, table.contactId)
      .where(sql`${table.contactId} IS NOT NULL`),
    check("alert_recipients_channel_check", sql`${table.channel} IN ('sms', 'email', 'voice', 'push')`),
    check(
      "alert_recipients_status_check",
      sql`${table.status} IN ('pending_delivery', 'dispatching', 'submitted', 'submission_failed', 'queued', 'delivered', 'failed')`,
    ),
    check(
      "alert_recipients_target_check",
      sql`${table.contactId} IS NOT NULL OR ${table.recipientAddress} IS NOT NULL`,
    ),
    check(
      "alert_recipients_last_failure_class_check",
      sql`${table.lastFailureClass} IS NULL OR ${table.lastFailureClass} IN ('transient', 'permanent')`,
    ),
  ],
);
