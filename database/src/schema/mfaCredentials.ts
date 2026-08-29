import { pgTable, uuid, text, varchar, timestamp, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

/**
 * One TOTP credential per user. `secret_ciphertext` holds the TOTP secret encrypted at rest
 * (AES-256-GCM) rather than hashed — unlike a password, the raw secret must be recoverable
 * server-side to compute and check submitted codes. `status` distinguishes an in-progress
 * enrollment (secret generated, not yet confirmed with a valid code) from an active credential.
 */
export const mfaCredentials = pgTable(
  "mfa_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secretCiphertext: text("secret_ciphertext").notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("mfa_credentials_user_id_idx").on(table.userId),
    check("mfa_credentials_status_check", sql`${table.status} IN ('pending', 'active')`),
  ],
);
