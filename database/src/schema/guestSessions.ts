import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { guestInvitations } from "./guestInvitations.js";

/**
 * Module 18 — temporary, incident-scoped Guest session, entirely separate from `sessions`
 * (registered-User auth, Module 02). Only the SHA-256 hash of the opaque session token is stored,
 * mirroring `sessions.token_hash` exactly. There is deliberately no `user_id` column anywhere on
 * this table — a Guest session authenticates against a `guest_invitations` row, never a `users`
 * row. See claude/prompts/18-otp-verification.md, "Guest session".
 */
export const guestSessions = pgTable(
  "guest_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invitationId: uuid("invitation_id")
      .notNull()
      .references(() => guestInvitations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("guest_sessions_invitation_id_idx").on(table.invitationId),
    index("guest_sessions_expires_at_idx").on(table.expiresAt),
  ],
);
