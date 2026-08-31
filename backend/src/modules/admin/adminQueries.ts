import { eq, sql } from "drizzle-orm";
import { roles, rolePermissions, permissions, userRoles, users, type Database } from "@beacon/database";
import type { RoleSummaryRow } from "./adminDto.js";

export interface BreakGlassStatusRow {
  present: boolean;
  status: string | null;
}

/** Never returns the break-glass account's email or any other identifying/credential field —
 * only whether one exists and its lifecycle status. */
export async function getBreakGlassStatus(db: Database): Promise<BreakGlassStatusRow> {
  const [row] = await db.select({ status: users.status }).from(users).where(eq(users.isBreakGlass, true)).limit(1);
  return { present: !!row, status: row?.status ?? null };
}

const PERMISSION_CODES_AGG = sql<
  string[]
>`array_remove(array_agg(distinct ${permissions.code}), null)`;
const USER_COUNT = sql<number>`(select count(*)::int from ${userRoles} where ${userRoles.roleId} = ${roles.id})`;

/**
 * Module 22 — the role-to-permission mapping and per-role User count `GET /roles`/`GET
 * /permissions` (Module 03) don't assemble together. Read-only; never touches `role_permissions`
 * writes — this codebase's roles/permissions remain seed-managed (see `rbac/routes.ts`'s own
 * doc comment), not runtime-editable. See claude/prompts/22-administration.md, "Role/permission
 * management".
 */
export async function getRoleSummaries(db: Database): Promise<RoleSummaryRow[]> {
  return db
    .select({
      id: roles.id,
      code: roles.code,
      name: roles.name,
      description: roles.description,
      permissionCodes: PERMISSION_CODES_AGG,
      userCount: USER_COUNT,
    })
    .from(roles)
    .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
    .groupBy(roles.id)
    .orderBy(roles.name);
}
