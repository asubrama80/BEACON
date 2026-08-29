import { pgTable, uuid, varchar, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { incidents } from "./incidents.js";

/**
 * Append-only audit trail. No update/delete-oriented columns by design. `actor_id` and
 * `resource_id` are intentionally not foreign-keyed — the actor/resource may come from any
 * of several tables (user, contact, guest) and the log must survive even if that row is
 * later removed. `metadata` must never contain secrets, passwords, plaintext OTPs, or raw tokens.
 */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventType: varchar("event_type", { length: 128 }).notNull(),
    actorType: varchar("actor_type", { length: 16 }).notNull(),
    actorId: uuid("actor_id"),
    incidentId: uuid("incident_id").references(() => incidents.id, { onDelete: "set null" }),
    resourceType: varchar("resource_type", { length: 128 }),
    resourceId: uuid("resource_id"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_logs_created_at_idx").on(table.createdAt),
    index("audit_logs_event_type_idx").on(table.eventType),
    index("audit_logs_resource_idx").on(table.resourceType, table.resourceId),
    check(
      "audit_logs_actor_type_check",
      sql`${table.actorType} IN ('user', 'contact', 'guest', 'system')`,
    ),
  ],
);
