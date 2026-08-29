import { AuthError } from "../auth/errors.js";

/**
 * The break-glass account (`users.is_break_glass`) is deliberately outside the reach of the
 * ordinary user-management API — no PATCH, disable/enable, role assignment, or password reset
 * through these routes may touch it. Its lifecycle is bootstrap/operational-only (see
 * `backend/scripts/bootstrap-user.ts` and Module 02's docs). This also means no request body
 * anywhere in this module can set `isBreakGlass` — the field simply isn't in any allowlist.
 */
export function assertNotBreakGlass(user: { isBreakGlass: boolean }): void {
  if (user.isBreakGlass) {
    throw new AuthError(
      403,
      "break_glass_protected",
      "The break-glass account cannot be modified through the standard user management API.",
    );
  }
}
