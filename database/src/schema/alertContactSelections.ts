import { pgTable, uuid, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { alerts } from "./alerts.js";
import { contacts } from "./contacts.js";

/**
 * DRAFT-time source selection: a direct Contact chosen for an Alert's audience. Distinct from
 * `alert_recipients` (the resolved, immutable snapshot written at READY) — this table explains
 * *intent* and stays live-editable while DRAFT. See claude/prompts/09-alert-engine.md, "Recipient
 * source model".
 */
export const alertContactSelections = pgTable(
  "alert_contact_selections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("alert_contact_selections_alert_contact_idx").on(table.alertId, table.contactId),
    index("alert_contact_selections_alert_id_idx").on(table.alertId),
  ],
);
