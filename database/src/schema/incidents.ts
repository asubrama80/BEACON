import { pgTable, uuid, varchar, text, timestamp, index, uniqueIndex, check, pgSequence } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

/**
 * Backs the human-readable `incident_number` (Module 08) — a single global monotonic counter,
 * not reset per calendar year. `nextval()` is lock-free and safe under concurrent inserts, which
 * is why a sequence is used instead of a "SELECT max()+1" pattern. See
 * claude/prompts/08-incident-management.md, "Incident identifier strategy" for the tradeoff.
 */
export const incidentNumberSeq = pgSequence("incident_number_seq", { startWith: 1, increment: 1 });

export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Server-generated only, e.g. "INC-2026-000001" — never accepted from a client. */
    incidentNumber: varchar("incident_number", { length: 32 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    severity: varchar("severity", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("open"),
    incidentCommanderId: uuid("incident_commander_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Set once, on creation — who created this Incident record (Module 08). */
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Set on close (Module 08) — CLOSED is terminal, so this is never cleared once set. */
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("incidents_incident_number_idx").on(table.incidentNumber),
    index("incidents_status_idx").on(table.status),
    index("incidents_severity_idx").on(table.severity),
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
