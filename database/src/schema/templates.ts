import { pgTable, uuid, varchar, text, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Message templates. Rendering/variable substitution is implemented in a later module. */
export const templates = pgTable(
  "templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    channel: varchar("channel", { length: 32 }).notNull(),
    severity: varchar("severity", { length: 32 }),
    subject: varchar("subject", { length: 255 }),
    body: text("body").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("templates_name_channel_idx").on(table.name, table.channel),
    check("templates_channel_check", sql`${table.channel} IN ('sms', 'email', 'voice', 'push')`),
    check("templates_status_check", sql`${table.status} IN ('active', 'inactive')`),
  ],
);
