import { pgTable, uuid, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { alerts } from "./alerts.js";
import { groups } from "./groups.js";

/**
 * DRAFT-time source selection: a Group chosen for an Alert's audience, expanded to its member
 * Contacts at preview/READY time. See `alert_contact_selections` for the sibling direct-Contact
 * selection table, and claude/prompts/09-alert-engine.md, "Group expansion/deduplication".
 */
export const alertGroupSelections = pgTable(
  "alert_group_selections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("alert_group_selections_alert_group_idx").on(table.alertId, table.groupId),
    index("alert_group_selections_alert_id_idx").on(table.alertId),
  ],
);
