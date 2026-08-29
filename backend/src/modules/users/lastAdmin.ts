import { and, eq, isNull, ne } from "drizzle-orm";
import { users, userRoles, roles, type Database } from "@beacon/database";
import { AuthError } from "../auth/errors.js";

/**
 * Counts currently-active, non-deleted users holding the ADMIN role, optionally excluding one
 * user from the count. Passing the user being acted on as `excludeUserId` directly answers
 * "how many active admins would remain after this action?" for both the disable-user and the
 * remove-ADMIN-role cases — a single helper covers both safeguards from the spec.
 */
export async function countActiveAdmins(db: Database, excludeUserId?: string): Promise<number> {
  const conditions = [eq(roles.code, "ADMIN"), eq(users.status, "active"), isNull(users.deletedAt)];
  if (excludeUserId) {
    conditions.push(ne(users.id, excludeUserId));
  }

  const rows = await db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(...conditions));

  return rows.length;
}

/**
 * Throws if excluding `targetUserId` from the active-admin count would leave zero — i.e. if
 * `targetUserId` is currently the last active administrator. Call this before disabling a user
 * or removing their ADMIN role. If the target isn't currently an active admin, excluding them
 * changes nothing and this is a no-op, so it's safe to call unconditionally.
 */
export async function assertNotLastActiveAdmin(db: Database, targetUserId: string): Promise<void> {
  const remaining = await countActiveAdmins(db, targetUserId);
  if (remaining === 0) {
    throw new AuthError(
      409,
      "last_admin_protected",
      "This is the last active administrator — BEACON cannot be left with zero active administrators.",
    );
  }
}
