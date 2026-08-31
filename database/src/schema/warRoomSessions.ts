import { pgTable, uuid, varchar, timestamp, index, uniqueIndex, check, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { incidentWarRooms } from "./incidentWarRooms.js";
import { users } from "./users.js";
import { incidentParticipants } from "./incidentParticipants.js";
import { guestInvitations } from "./guestInvitations.js";

/**
 * A War Room *session* — an actual join/leave record — distinct from `incident_participants` (the
 * Incident roster). Being on the roster never implies having joined the room, and joining never
 * auto-adds someone to the roster; these are two separate concepts kept in two separate tables.
 * `user_id` is nullable and `participant_type` stays schema-open for a future `'guest'` value on
 * purpose — Module 14 only ever writes `'user'`, but the shape must not force every future
 * participant (Modules 17-18's Guests) to hold a `users` row. See
 * claude/prompts/14-war-room-foundation.md, "Incident Participant vs War Room session".
 */
export const warRoomSessions = pgTable(
  "war_room_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    warRoomId: uuid("war_room_id")
      .notNull()
      .references(() => incidentWarRooms.id, { onDelete: "cascade" }),
    participantType: varchar("participant_type", { length: 16 }).notNull().default("user"),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** Module 19 — a Guest joiner's identity anchor, mirroring `incident_participants`'s exact
     * `guest_invitation_id` pattern. Never set alongside `user_id`. */
    guestInvitationId: uuid("guest_invitation_id"),
    /** Optional cross-reference to the Incident roster entry, if the joiner is also a participant. */
    incidentParticipantId: uuid("incident_participant_id"),
    status: varchar("status", { length: 16 }).notNull().default("joined"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("war_room_sessions_war_room_id_idx").on(table.warRoomId),
    // Prevents a duplicate *active* session for the same User in the same room — repeated Join is
    // idempotent at the service layer (returns the existing active session) precisely because
    // this index makes a second concurrent insert impossible, not just discouraged.
    uniqueIndex("war_room_sessions_active_user_idx")
      .on(table.warRoomId, table.userId)
      .where(sql`${table.status} = 'joined' AND ${table.userId} IS NOT NULL`),
    // Module 19 — the Guest equivalent, closing the gap the comment above used to describe: a
    // Guest join previously had no DB-level duplicate-active-session guarantee at all.
    uniqueIndex("war_room_sessions_active_guest_idx")
      .on(table.warRoomId, table.guestInvitationId)
      .where(sql`${table.status} = 'joined' AND ${table.guestInvitationId} IS NOT NULL`),
    // Explicit short name: the auto-generated name for this FK exceeds PostgreSQL's 63-byte
    // identifier limit and gets silently truncated (surfaced as a NOTICE on migrate) — same issue
    // Module 08 hit for incident_participants_guest_invitation_fk.
    foreignKey({
      columns: [table.incidentParticipantId],
      foreignColumns: [incidentParticipants.id],
      name: "war_room_sessions_incident_participant_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.guestInvitationId],
      foreignColumns: [guestInvitations.id],
      name: "war_room_sessions_guest_invitation_fk",
    }).onDelete("cascade"),
    check("war_room_sessions_participant_type_check", sql`${table.participantType} IN ('user', 'guest')`),
    check("war_room_sessions_status_check", sql`${table.status} IN ('joined', 'left')`),
    // Module 19 — tightened from the Module 14 placeholder (which allowed a 'guest' row with
    // neither identity column set) to require the matching reference, exactly like
    // `incident_participants_reference_check`.
    check(
      "war_room_sessions_reference_check",
      sql`
        (${table.participantType} = 'user' AND ${table.userId} IS NOT NULL AND ${table.guestInvitationId} IS NULL)
        OR (${table.participantType} = 'guest' AND ${table.guestInvitationId} IS NOT NULL AND ${table.userId} IS NULL)
      `,
    ),
  ],
);
