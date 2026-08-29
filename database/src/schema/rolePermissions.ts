import { pgTable, uuid, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { roles } from "./roles.js";
import { permissions } from "./permissions.js";

/**
 * Grants a permission to a role. A user's effective permissions are the union, across every
 * role assigned to them, of the permissions granted to those roles (deduplicated).
 */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: uuid("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("role_permissions_role_permission_idx").on(table.roleId, table.permissionId),
    index("role_permissions_permission_id_idx").on(table.permissionId),
  ],
);
