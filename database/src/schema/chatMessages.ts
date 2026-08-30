import { pgTable, uuid, varchar, text, timestamp, serial, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { incidents } from "./incidents.js";
import { users } from "./users.js";
import { incidentParticipants } from "./incidentParticipants.js";

/**
 * Message record foundation (Module 01), realtime delivery wired up in Module 13. `seq` (added in
 * Module 13, mirroring `incident_timeline_events.seq`) is a separate auto-incrementing tiebreaker
 * — not the primary key — purely so ordering stays deterministic even when two messages share the
 * same `created_at` timestamp (a real possibility under concurrent senders, since `timestamp`
 * precision alone is not a safe uniqueness/ordering guarantee). Module 13 supports registered
 * Users only (`author_type = 'user'`) — `'guest'` remains schema-compatible for a future module,
 * unused until then.
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: serial("seq").notNull(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    authorType: varchar("author_type", { length: 16 }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Non-user authors (guests/contacts) are identified via their War Room participant record. */
    participantId: uuid("participant_id").references(() => incidentParticipants.id, {
      onDelete: "set null",
    }),
    messageText: text("message_text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chat_messages_seq_idx").on(table.seq),
    index("chat_messages_incident_created_at_idx").on(table.incidentId, table.createdAt, table.seq),
    check("chat_messages_author_type_check", sql`${table.authorType} IN ('user', 'guest')`),
    check(
      "chat_messages_author_reference_check",
      sql`
        (${table.authorType} = 'user' AND ${table.userId} IS NOT NULL)
        OR (${table.authorType} = 'guest' AND ${table.participantId} IS NOT NULL)
      `,
    ),
  ],
);
