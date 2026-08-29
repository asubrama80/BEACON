import { pgTable, uuid, varchar, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { incidents } from "./incidents.js";
import { templates } from "./templates.js";
import { users } from "./users.js";

/** Alert dispatch record foundation. Sending/delivery logic is implemented in a later module. */
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id").references(() => incidents.id, { onDelete: "set null" }),
    templateId: uuid("template_id").references(() => templates.id, { onDelete: "set null" }),
    channel: varchar("channel", { length: 32 }).notNull(),
    subject: varchar("subject", { length: 255 }),
    /** Snapshot of the rendered message payload at send time. */
    body: text("body").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("draft"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("alerts_incident_status_idx").on(table.incidentId, table.status),
    check("alerts_channel_check", sql`${table.channel} IN ('sms', 'email', 'voice', 'push')`),
    check(
      "alerts_status_check",
      sql`${table.status} IN ('draft', 'queued', 'sending', 'sent', 'failed')`,
    ),
  ],
);
