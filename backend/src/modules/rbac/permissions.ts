import { eq } from "drizzle-orm";
import {
  userRoles,
  rolePermissions,
  permissions,
  roles,
  type Database,
  type Module03PermissionCode,
  type Module04PermissionCode,
} from "@beacon/database";

/** Union of every module's seeded permission codes — extend as each new module adds its own. */
export type PermissionCode = Module03PermissionCode | Module04PermissionCode;

/**
 * Effective permissions: the UNION of every permission granted by every role assigned to the
 * user, deduplicated. `selectDistinct` dedupes at the SQL level (belt-and-suspenders with the
 * `Set` return type) — a user with e.g. both RESPONDER and AUDITOR never sees a permission twice.
 */
export async function getEffectivePermissions(db: Database, userId: string): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ code: permissions.code })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
    .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .where(eq(userRoles.userId, userId));

  return new Set(rows.map((row) => row.code));
}

export async function hasPermission(db: Database, userId: string, code: string): Promise<boolean> {
  const effective = await getEffectivePermissions(db, userId);
  return effective.has(code);
}

export interface UserRoleRecord {
  id: string;
  code: string;
  name: string;
}

export async function getUserRoles(db: Database, userId: string): Promise<UserRoleRecord[]> {
  return db
    .select({ id: roles.id, code: roles.code, name: roles.name })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId));
}
