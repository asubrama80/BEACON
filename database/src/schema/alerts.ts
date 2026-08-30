import { pgTable, uuid, varchar, text, timestamp, integer, jsonb, index, uniqueIndex, check, pgSequence } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { incidents } from "./incidents.js";
import { templates } from "./templates.js";
import { users } from "./users.js";

/**
 * Backs the human-readable `alert_number` (Module 09) — a single global monotonic counter, not
 * reset per calendar year, mirroring `incident_number_seq` (Module 08). See
 * claude/prompts/09-alert-engine.md, "Alert identifier strategy".
 */
export const alertNumberSeq = pgSequence("alert_number_seq", { startWith: 1, increment: 1 });

/**
 * Alert dispatch record foundation. Module 09 owns DRAFT/READY/CANCELLED. Module 10 owns
 * DISPATCHING/SUBMITTED/PARTIALLY_SUBMITTED/SUBMISSION_FAILED — an Alert-level aggregate of its
 * recipients' provider-submission outcomes, never "delivered" (that's Module 11's job). The
 * original Module 01 placeholders QUEUED/SENDING/SENT/FAILED remain structurally allowed but
 * unused — superseded by these more precise values. See
 * claude/prompts/09-alert-engine.md, "Alert lifecycle" and
 * claude/prompts/10-notification-providers.md, "Alert vs recipient submission state".
 */
export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Server-generated only, e.g. "ALT-2026-000001" — never accepted from a client. */
    alertNumber: varchar("alert_number", { length: 32 }).notNull(),
    /** Operator-facing label, distinct from message content — always editable while DRAFT. */
    title: varchar("title", { length: 255 }).notNull(),
    incidentId: uuid("incident_id").references(() => incidents.id, { onDelete: "set null" }),
    templateId: uuid("template_id").references(() => templates.id, { onDelete: "set null" }),
    /** 'template' or 'adhoc' — see claude/prompts/09-alert-engine.md, "Template vs ad-hoc model". */
    contentSource: varchar("content_source", { length: 16 }).notNull().default("adhoc"),
    /** Snapshot of the Template's name at READY time — the Template itself may be renamed later. */
    templateNameSnapshot: varchar("template_name_snapshot", { length: 255 }),
    channel: varchar("channel", { length: 32 }).notNull(),
    /**
     * Frozen SOURCE content (placeholders un-substituted) once READY — ad-hoc content is
     * editable here while DRAFT; template-based content is copied from the current Template at
     * READY time. Per-recipient PERSONALIZED content lives on `alert_recipients` instead — see
     * claude/prompts/09-alert-engine.md, "Content snapshot verification".
     */
    subject: varchar("subject", { length: 255 }),
    body: text("body"),
    status: varchar("status", { length: 32 }).notNull().default("draft"),
    /** Safe, PII-free counts snapshotted at READY — never recipient identities. */
    eligibleRecipientCount: integer("eligible_recipient_count"),
    excludedCount: integer("excluded_count"),
    exclusionSummary: jsonb("exclusion_summary"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("alerts_alert_number_idx").on(table.alertNumber),
    index("alerts_incident_status_idx").on(table.incidentId, table.status),
    index("alerts_status_idx").on(table.status),
    check("alerts_channel_check", sql`${table.channel} IN ('sms', 'email', 'voice', 'push')`),
    check("alerts_content_source_check", sql`${table.contentSource} IN ('template', 'adhoc')`),
    check(
      "alerts_status_check",
      sql`${table.status} IN ('draft', 'ready', 'cancelled', 'dispatching', 'submitted', 'partially_submitted', 'submission_failed', 'queued', 'sending', 'sent', 'failed')`,
    ),
  ],
);
