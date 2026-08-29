import { pgTable, uuid, varchar, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    severity: varchar("severity", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("open"),
    incidentCommanderId: uuid("incident_commander_id").references(() => users.id, {
      onDelete: "set null",
    }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("incidents_status_idx").on(table.status),
    check(
      "incidents_severity_check",
      sql`${table.severity} IN ('info', 'warning', 'high', 'critical')`,
    ),
    check(
      "incidents_status_check",
      sql`${table.status} IN ('open', 'active', 'resolved', 'closed')`,
    ),
  ],
);
