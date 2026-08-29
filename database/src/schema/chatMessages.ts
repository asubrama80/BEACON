import { pgTable, uuid, varchar, text, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { incidents } from "./incidents.js";
import { users } from "./users.js";
import { incidentParticipants } from "./incidentParticipants.js";

/** Message record foundation. Realtime delivery over WebSocket is implemented in a later module. */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
    index("chat_messages_incident_created_at_idx").on(table.incidentId, table.createdAt),
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
