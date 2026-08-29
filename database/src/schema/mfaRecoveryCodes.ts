import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./users.js";

/**
 * One-time MFA recovery codes. Only a SHA-256 hash of each code is stored; the plaintext is
 * shown to the user once, at generation time, and never persisted or logged. Regenerating a
 * user's codes deletes all of their existing rows (old codes stop working immediately).
 */
export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("mfa_recovery_codes_user_id_idx").on(table.userId)],
);
