import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { users, userRoles, roles, type Database, type DbOrTx } from "@beacon/database";
import { AuthError } from "../auth/errors.js";

/**
 * Counts currently-active, non-deleted users holding the ADMIN role, optionally excluding one
 * user from the count. Passing the user being acted on as `excludeUserId` directly answers
 * "how many active admins would remain after this action?" for both the disable-user and the
 * remove-ADMIN-role cases — a single helper covers both safeguards from the spec. This is the
 * plain, unlocked read used for general status/summary views; `assertNotLastActiveAdmin` below
 * is the race-safe variant that must be used before actually removing admin status.
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
 * or removing their ADMIN role, and always inside the same `db.transaction()` as that mutation.
 *
 * Module 23 — the previous implementation (a plain unlocked count) had a real TOCTOU race: with
 * exactly two active admins A and B, two concurrent requests disabling A and B respectively could
 * both read "1 remaining" before either commits, and both proceed, leaving zero active admins.
 * Postgres doesn't allow `FOR UPDATE` combined with the `DISTINCT`+join query above (`SELECT
 * DISTINCT ... FOR UPDATE` is rejected outright), so this locks the candidate admin `users` rows
 * directly in a second, targeted query. Two concurrent transactions locking the same overlapping
 * row set serialize on that lock — the second call blocks until the first transaction commits (or
 * rolls back), then re-reads the now-current `status`, closing the race. See
 * claude/prompts/23-security-hardening.md, "Last-admin race condition".
 */
export async function assertNotLastActiveAdmin(tx: DbOrTx, targetUserId: string): Promise<void> {
  const candidates = await tx
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.code, "ADMIN"), eq(users.status, "active"), isNull(users.deletedAt)));

  const candidateIds = candidates.map((row) => row.id);
  if (candidateIds.length === 0) {
    // targetUserId isn't currently an active admin (or none exist) — nothing to protect.
    return;
  }

  const locked = await tx
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(inArray(users.id, candidateIds))
    .for("update");

  const remaining = locked.filter((row) => row.status === "active" && row.id !== targetUserId).length;
  if (remaining === 0) {
    throw new AuthError(
      409,
      "last_admin_protected",
      "This is the last active administrator — BEACON cannot be left with zero active administrators.",
    );
  }
}
