import { pgTable, uuid, varchar, jsonb, timestamp, serial, index, uniqueIndex } from "drizzle-orm/pg-core";
import { incidents } from "./incidents.js";
import { users } from "./users.js";

/**
 * Append-only operational timeline for a single Incident — "what happened during this
 * Incident", distinct from the global `audit_logs` table ("who performed an auditable system
 * action"). No update/delete endpoint exists; business services only ever insert. `seq` is a
 * separate auto-incrementing tiebreaker (not the primary key) purely so ordering stays
 * deterministic even when two events share the same `occurred_at` timestamp — insertion order,
 * not UUID randomness.
 */
export const incidentTimelineEvents = pgTable(
  "incident_timeline_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: serial("seq").notNull(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    eventType: varchar("event_type", { length: 64 }).notNull(),
    /** Null for a system-generated event; set to the acting User otherwise. */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Safe, non-PII context only — see claude/prompts/08-incident-management.md, "Timeline privacy". */
    metadata: jsonb("metadata").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("incident_timeline_events_seq_idx").on(table.seq),
    index("incident_timeline_events_incident_id_idx").on(table.incidentId),
    index("incident_timeline_events_order_idx").on(table.incidentId, table.occurredAt, table.seq),
  ],
);
