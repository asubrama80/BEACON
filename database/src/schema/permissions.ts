import { pgTable, uuid, varchar, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Stable, machine-readable permission codes (`resource.action`, e.g. `users.read`). The
 * primary authorization mechanism for BEACON — application code checks permission codes via
 * `requirePermission()`, never role-name comparisons. Each module adds its own permissions
 * when it's implemented; this table only carries Module 03's user-administration permissions.
 */
export const permissions = pgTable(
  "permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: varchar("code", { length: 128 }).notNull().unique(),
    name: varchar("name", { length: 128 }).notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("permissions_code_idx").on(table.code)],
);
