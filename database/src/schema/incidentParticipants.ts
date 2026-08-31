import { pgTable, uuid, varchar, timestamp, index, uniqueIndex, check, foreignKey } from "drizzle-orm/pg-core";
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
    // Module 08: prevents a User or Contact from having more than one non-removed participant
    // row on the same Incident — the real duplicate-prevention guarantee (the service layer's
    // pre-check is only for a clean error message, not the actual safety net). Removing then
    // re-adding the same identity creates a new row, since the removed one falls outside this
    // partial index's scope.
    uniqueIndex("incident_participants_active_user_idx")
      .on(table.incidentId, table.userId)
      .where(sql`${table.status} != 'removed' AND ${table.userId} IS NOT NULL`),
    uniqueIndex("incident_participants_active_contact_idx")
      .on(table.incidentId, table.contactId)
      .where(sql`${table.status} != 'removed' AND ${table.contactId} IS NOT NULL`),
    // Module 19 — the same duplicate-prevention guarantee for a verified Guest's auto-enrolled
    // participant row, backing the race-safe idempotent enrollment in
    // guestVerificationService.verifyOtp(). See claude/prompts/19-participant-management.md,
    // "Auto-enrollment".
    uniqueIndex("incident_participants_active_guest_idx")
      .on(table.incidentId, table.guestInvitationId)
      .where(sql`${table.status} != 'removed' AND ${table.guestInvitationId} IS NOT NULL`),
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
