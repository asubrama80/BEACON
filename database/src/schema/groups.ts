import { pgTable, uuid, varchar, text, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { contacts } from "./contacts.js";

export const groups = pgTable(
  "groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Case-insensitive uniqueness (Module 06) — "IT Operations" and "it operations" collide —
    // scoped to non-deleted groups only; disabling a group does NOT free its name for reuse.
    // The raw `name` column still preserves the operator's original display casing.
    uniqueIndex("groups_name_lower_unique_idx")
      .on(sql`lower(${table.name})`)
      .where(sql`${table.deletedAt} IS NULL`),
    index("groups_status_idx").on(table.status),
    check("groups_status_check", sql`${table.status} IN ('active', 'inactive')`),
  ],
);

/** Static membership foundation. Dynamic/rule-based groups are a later module. */
export const groupMembers = pgTable(
  "group_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("group_members_group_contact_idx").on(table.groupId, table.contactId),
    index("group_members_group_id_idx").on(table.groupId),
  ],
);
