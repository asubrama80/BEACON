import { pgTable, uuid, varchar, text, timestamp } from "drizzle-orm/pg-core";

export const roles = pgTable("roles", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 128 }).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Fixed set of system role codes seeded by Module 01. Authorization behavior is implemented in a later module. */
export const SYSTEM_ROLE_CODES = [
  "ADMIN",
  "INCIDENT_COMMANDER",
  "COMMUNICATION_MANAGER",
  "RESPONDER",
  "AUDITOR",
] as const;

export type SystemRoleCode = (typeof SYSTEM_ROLE_CODES)[number];
