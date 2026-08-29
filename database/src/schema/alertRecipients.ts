import { pgTable, uuid, varchar, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { alerts } from "./alerts.js";
import { contacts } from "./contacts.js";

/**
 * Per-recipient delivery record. `contact_id` is optional so an alert can also target an
 * external/manual recipient captured only as a name/address snapshot — delivery never
 * requires a BEACON user account.
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
    channel: varchar("channel", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("queued"),
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
    check("alert_recipients_channel_check", sql`${table.channel} IN ('sms', 'email', 'voice', 'push')`),
    check(
      "alert_recipients_status_check",
      sql`${table.status} IN ('queued', 'submitted', 'delivered', 'failed')`,
    ),
    check(
      "alert_recipients_target_check",
      sql`${table.contactId} IS NOT NULL OR ${table.recipientAddress} IS NOT NULL`,
    ),
  ],
);
