import { pgTable, uuid, varchar, timestamp, index, check, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { incidents } from "./incidents.js";
import { users } from "./users.js";
import { contacts } from "./contacts.js";
import { guestInvitations } from "./guestInvitations.js";

/**
 * Represents War Room participation across BEACON's three access models — a registered
 * responder (`user_id`), a directory contact (`contact_id`), or a temporary verified guest
 * (`guest_invitation_id`) — without forcing every participant to hold a login account.
 * `participant_type` and a check constraint enforce that exactly the matching reference is set.
 */
export const incidentParticipants = pgTable(
  "incident_participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    participantType: varchar("participant_type", { length: 16 }).notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "cascade" }),
    guestInvitationId: uuid("guest_invitation_id"),
    participantRole: varchar("participant_role", { length: 64 }).notNull().default("participant"),
    status: varchar("status", { length: 16 }).notNull().default("invited"),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("incident_participants_incident_id_idx").on(table.incidentId),
    // Explicit short name: the auto-generated name for this FK exceeds PostgreSQL's
    // 63-byte identifier limit and gets silently truncated (surfaced as a NOTICE on migrate).
    foreignKey({
      columns: [table.guestInvitationId],
      foreignColumns: [guestInvitations.id],
      name: "incident_participants_guest_invitation_fk",
    }).onDelete("cascade"),
    check(
      "incident_participants_type_check",
      sql`${table.participantType} IN ('user', 'contact', 'guest')`,
    ),
    check(
      "incident_participants_status_check",
      sql`${table.status} IN ('invited', 'joined', 'left', 'removed')`,
    ),
    check(
      "incident_participants_reference_check",
      sql`
        (${table.participantType} = 'user' AND ${table.userId} IS NOT NULL AND ${table.contactId} IS NULL AND ${table.guestInvitationId} IS NULL)
        OR (${table.participantType} = 'contact' AND ${table.contactId} IS NOT NULL AND ${table.userId} IS NULL AND ${table.guestInvitationId} IS NULL)
        OR (${table.participantType} = 'guest' AND ${table.guestInvitationId} IS NOT NULL AND ${table.userId} IS NULL AND ${table.contactId} IS NULL)
      `,
    ),
  ],
);
