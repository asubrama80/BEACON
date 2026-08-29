import {
  pgTable,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { roles } from "./roles.js";

/**
 * Registered BEACON users (login accounts). Deliberately separate from `contacts`,
 * which are alert-recipient directory entries that never require a login.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: varchar("email", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("active"),
    /** Argon2id hash. Never a plaintext or reversibly-encrypted password. */
    passwordHash: text("password_hash"),
    /**
     * Marks the single local emergency break-glass administrator account (Module 02).
     * A partial unique index guarantees at most one row can have this set.
     */
    isBreakGlass: boolean("is_break_glass").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("users_email_idx").on(table.email),
    uniqueIndex("users_single_break_glass_idx")
      .on(table.isBreakGlass)
      .where(sql`${table.isBreakGlass} = true`),
    check("users_status_check", sql`${table.status} IN ('active', 'inactive', 'suspended')`),
  ],
);

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("user_roles_user_role_idx").on(table.userId, table.roleId)],
);
