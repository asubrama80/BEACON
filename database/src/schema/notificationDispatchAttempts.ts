import { pgTable, uuid, varchar, integer, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { alerts } from "./alerts.js";
import { alertRecipients } from "./alertRecipients.js";

/**
 * Append-only technical dispatch history (Module 10) — one row per provider-submission attempt.
 * Never holds destination/subject/body/credentials/raw provider responses; only safe correlation
 * ids, provider name, classification, and timestamps. See
 * claude/prompts/10-notification-providers.md, "Dispatch attempt history".
 */
export const notificationDispatchAttempts = pgTable(
  "notification_dispatch_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    alertRecipientId: uuid("alert_recipient_id")
      .notNull()
      .references(() => alertRecipients.id, { onDelete: "cascade" }),
    channel: varchar("channel", { length: 32 }).notNull(),
    provider: varchar("provider", { length: 32 }).notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    providerMessageId: varchar("provider_message_id", { length: 255 }),
    failureClass: varchar("failure_class", { length: 16 }),
    providerErrorCode: varchar("provider_error_code", { length: 64 }),
    safeErrorSummary: varchar("safe_error_summary", { length: 255 }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("notification_dispatch_attempts_alert_id_idx").on(table.alertId),
    index("notification_dispatch_attempts_recipient_id_idx").on(table.alertRecipientId),
    uniqueIndex("notification_dispatch_attempts_recipient_attempt_idx").on(table.alertRecipientId, table.attemptNumber),
    check("notification_dispatch_attempts_channel_check", sql`${table.channel} IN ('sms', 'email', 'voice', 'push')`),
    check("notification_dispatch_attempts_status_check", sql`${table.status} IN ('dispatching', 'submitted', 'submission_failed')`),
    check(
      "notification_dispatch_attempts_failure_class_check",
      sql`${table.failureClass} IS NULL OR ${table.failureClass} IN ('transient', 'permanent')`,
    ),
  ],
);
