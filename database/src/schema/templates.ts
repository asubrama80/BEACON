import { pgTable, uuid, varchar, text, timestamp, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Message templates (Module 07 implements the `sms`/`email` channels; `voice`/`push` remain
 * structurally allowed by the check constraint below for a future module, but nothing in this
 * module's API accepts or creates them). Rendering/variable substitution lives in
 * `backend/src/modules/templates/rendering.ts`, reusable by a future Alert module.
 */
export const templates = pgTable(
  "templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    channel: varchar("channel", { length: 32 }).notNull(),
    /** Unused by Module 07 — reserved from Module 01's original schema for a future module. */
    severity: varchar("severity", { length: 32 }),
    subject: varchar("subject", { length: 255 }),
    body: text("body").notNull(),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Case-insensitive uniqueness (Module 06's Groups pattern), scoped per channel — preserving
    // Module 01's original decision that "Emergency Closure" SMS and "Emergency Closure" Email
    // may coexist as separate Templates — and to non-deleted rows; disabling a Template does not
    // free its name for reuse, same rationale as Groups.
    uniqueIndex("templates_name_lower_channel_unique_idx")
      .on(sql`lower(${table.name})`, table.channel)
      .where(sql`${table.deletedAt} IS NULL`),
    index("templates_status_idx").on(table.status),
    check("templates_channel_check", sql`${table.channel} IN ('sms', 'email', 'voice', 'push')`),
    check("templates_status_check", sql`${table.status} IN ('active', 'inactive')`),
  ],
);
