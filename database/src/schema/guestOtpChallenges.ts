import { pgTable, uuid, varchar, text, integer, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { guestInvitations } from "./guestInvitations.js";

/**
 * Module 18 — a one-time verification challenge proving control of a guest invitation's
 * destination. Only a salted hash of the 6-digit code is ever persisted; the raw code exists only
 * transiently, inside the outbound SMS/email body. See claude/prompts/18-otp-verification.md,
 * "OTP storage".
 */
export const guestOtpChallenges = pgTable(
  "guest_otp_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invitationId: uuid("invitation_id")
      .notNull()
      .references(() => guestInvitations.id, { onDelete: "cascade" }),
    codeSalt: text("code_salt").notNull(),
    codeHash: text("code_hash").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("active"),
    attemptCount: integer("attempt_count").notNull().default(0),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("guest_otp_challenges_invitation_id_idx").on(table.invitationId),
    // At most one ACTIVE challenge per invitation — requesting a new OTP must first supersede any
    // still-active prior one (done in the same transaction), so this index is the real
    // race-safety guarantee for concurrent resend requests, not just a service-layer pre-check.
    uniqueIndex("guest_otp_challenges_active_idx").on(table.invitationId).where(sql`${table.status} = 'active'`),
    check(
      "guest_otp_challenges_status_check",
      sql`${table.status} IN ('active', 'consumed', 'expired', 'superseded', 'locked')`,
    ),
  ],
);
