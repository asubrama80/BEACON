import { pgTable, uuid, varchar, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Alert-recipient directory entries. Contacts are intentionally independent of `users`
 * (no `user_id`, no login) — see CLAUDE.md: contacts and application users are separate concepts.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referenceId: varchar("reference_id", { length: 64 }),
    firstName: varchar("first_name", { length: 128 }).notNull(),
    lastName: varchar("last_name", { length: 128 }).notNull(),
    email: varchar("email", { length: 255 }),
    mobilePhone: varchar("mobile_phone", { length: 32 }),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("contacts_reference_id_idx").on(table.referenceId),
    index("contacts_email_idx").on(table.email),
    index("contacts_status_idx").on(table.status),
    check("contacts_status_check", sql`${table.status} IN ('active', 'inactive')`),
  ],
);
