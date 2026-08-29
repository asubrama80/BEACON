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
    /** Trimmed/lowercased at write time — this column always holds the normalized form. */
    email: varchar("email", { length: 255 }),
    /** E.164-normalized at write time (e.g. "+15551234567") — never stored in raw/display form. */
    mobilePhone: varchar("mobile_phone", { length: 32 }),
    /** Free-text organizational unit (Module 04). Not a foreign key — no org-structure module exists yet. */
    department: varchar("department", { length: 128 }),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("contacts_reference_id_idx").on(table.referenceId),
    index("contacts_email_idx").on(table.email),
    index("contacts_mobile_phone_idx").on(table.mobilePhone),
    index("contacts_status_idx").on(table.status),
    check("contacts_status_check", sql`${table.status} IN ('active', 'inactive')`),
  ],
);
