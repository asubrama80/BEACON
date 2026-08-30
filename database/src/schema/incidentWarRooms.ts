import { pgTable, uuid, varchar, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { incidents } from "./incidents.js";
import { users } from "./users.js";

/**
 * Module 14 foundation — deliberately provider-neutral. A row here represents only that a War
 * Room has been opened for an Incident; it carries no meeting URL, no provider room id, no media
 * token, no participant media state. A row is only ever created once a room is actually opened —
 * "NOT_STARTED" is represented by the *absence* of a row for an Incident, not a third status
 * value, since a room that has never existed needs no queryable state of its own. See
 * claude/prompts/14-war-room-foundation.md, "Lifecycle".
 */
export const incidentWarRooms = pgTable(
  "incident_war_rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 16 }).notNull().default("open"),
    openedByUserId: uuid("opened_by_user_id").references(() => users.id, { onDelete: "set null" }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    endedByUserId: uuid("ended_by_user_id").references(() => users.id, { onDelete: "set null" }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("incident_war_rooms_incident_id_idx").on(table.incidentId),
    // At most one OPEN room per Incident — the real duplicate-open guarantee, not just a
    // service-layer pre-check. Ending a room and opening a new one is allowed (a new row), since
    // this index only scopes rows currently `status = 'open'`.
    uniqueIndex("incident_war_rooms_active_idx").on(table.incidentId).where(sql`${table.status} = 'open'`),
    check("incident_war_rooms_status_check", sql`${table.status} IN ('open', 'ended')`),
  ],
);
