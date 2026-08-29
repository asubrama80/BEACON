import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  jsonb,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { incidents } from "./incidents.js";
import { users } from "./users.js";

/**
 * Temporary, incident-scoped guest access. Tokens and OTPs are stored as hashes only —
 * never plaintext. The invitation/OTP flow itself is implemented in a later module.
 */
export const guestInvitations = pgTable(
  "guest_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    incidentId: uuid("incident_id")
      .notNull()
      .references(() => incidents.id, { onDelete: "cascade" }),
    guestName: varchar("guest_name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }),
    mobilePhone: varchar("mobile_phone", { length: 32 }),
    status: varchar("status", { length: 32 }).notNull().default("pending"),
    tokenHash: text("token_hash").notNull(),
    otpHash: text("otp_hash"),
    /** Foundation permission toggles, e.g. { "chat": true, "video": false, "screenSharing": false }. */
    permissions: jsonb("permissions").notNull().default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("guest_invitations_incident_status_idx").on(table.incidentId, table.status),
    index("guest_invitations_expires_at_idx").on(table.expiresAt),
    check(
      "guest_invitations_status_check",
      sql`${table.status} IN ('pending', 'sent', 'verified', 'joined', 'expired', 'revoked')`,
    ),
    check(
      "guest_invitations_contact_method_check",
      sql`${table.email} IS NOT NULL OR ${table.mobilePhone} IS NOT NULL`,
    ),
  ],
);
