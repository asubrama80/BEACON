import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { eq } from "drizzle-orm";
import { checkDatabaseHealth, mfaCredentials, mfaRecoveryCodes, type Database } from "@beacon/database";
import { AuthError } from "../auth/errors.js";
import { recordAuthEvent } from "../auth/audit.js";
import { revokeAllSessionsForUser } from "../auth/session.js";
import { findActiveMfaCredential } from "../auth/userAuth.js";
import type { AuthConfig } from "../auth/config.js";
import type { AppEnv } from "../../config/env.js";
import type { NotificationConfig } from "../notifications/config.js";
import { findSafeUserById } from "../users/userQueries.js";
import { assertNotBreakGlass } from "../users/breakGlass.js";
import { getBreakGlassStatus, getRoleSummaries as queryRoleSummaries } from "./adminQueries.js";
import { toRoleSummaryDto, type AdminStatusDto, type RoleSummaryDto } from "./adminDto.js";

/** Read once at module load — a static build identifier, never re-read per request. Resolves
 * relative to this file's own location, which sits at the same depth under `backend/` whether
 * running from `src/` (tsx/dev) or the compiled `dist/` output. */
const APP_VERSION: string = (() => {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

/**
 * Explicit, allowlisted status — every field is named individually below; nothing from
 * `process.env` or any config object is ever spread/serialized wholesale. See
 * claude/prompts/22-administration.md, "System/Security status".
 */
export async function getAdminStatus(
  env: AppEnv,
  authConfig: AuthConfig,
  notificationConfig: NotificationConfig,
  db: Database,
): Promise<AdminStatusDto> {
  const [database, breakGlass] = await Promise.all([checkDatabaseHealth(), getBreakGlassStatus(db)]);

  return {
    application: { name: env.appName, version: APP_VERSION, environment: env.nodeEnv },
    database: { connected: database.connected },
    security: {
      mfaAvailable: true,
      sessionTtlHours: Math.round((authConfig.sessionTtlSeconds / 3600) * 100) / 100,
      passwordMinLength: authConfig.passwordMinLength,
      loginMaxFailures: authConfig.loginMaxFailures,
      breakGlass,
    },
    providers: { sms: notificationConfig.smsProvider, email: notificationConfig.emailProvider },
    collaboration: { status: "foundation_only" },
  };
}

export async function getRoleSummaries(db: Database): Promise<RoleSummaryDto[]> {
  const rows = await queryRoleSummaries(db);
  return rows.map(toRoleSummaryDto);
}

async function assertManageableTarget(db: Database, userId: string): Promise<void> {
  const user = await findSafeUserById(db, userId);
  if (!user) {
    throw new AuthError(404, "not_found", "User not found.");
  }
  assertNotBreakGlass(user);
}

/**
 * Forces re-authentication without disabling the account — distinct from
 * `users/service.ts`'s `disableUser()` (which already revokes sessions as a side effect of
 * disabling). This is the "I suspect this session was compromised, but the User should stay
 * active" action. See claude/prompts/22-administration.md, "Session administration".
 */
export async function revokeUserSessions(db: Database, targetUserId: string, actorId: string): Promise<void> {
  await assertManageableTarget(db, targetUserId);
  await revokeAllSessionsForUser(db, targetUserId);
  await recordAuthEvent(db, {
    eventType: "USER_SESSIONS_ADMIN_REVOKED",
    actorId,
    resourceType: "user",
    resourceId: targetUserId,
  });
}

/**
 * Admin-privileged MFA reset — deletes the target's MFA credential/recovery codes (never reads
 * or exposes the TOTP secret) and requires the User to re-enroll from scratch, mirroring the
 * self-service `/auth/mfa/disable` flow's actual DB operations exactly, just under
 * admin authorization instead of the User's own password confirmation. See
 * claude/prompts/22-administration.md, "MFA admin actions".
 */
export async function resetUserMfa(db: Database, targetUserId: string, actorId: string): Promise<void> {
  await assertManageableTarget(db, targetUserId);

  const active = await findActiveMfaCredential(db, targetUserId);
  if (!active) {
    throw new AuthError(409, "mfa_not_enabled", "This User does not currently have MFA enabled.");
  }

  await db.delete(mfaCredentials).where(eq(mfaCredentials.userId, targetUserId));
  await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, targetUserId));

  await recordAuthEvent(db, {
    eventType: "MFA_ADMIN_RESET",
    actorId,
    resourceType: "user",
    resourceId: targetUserId,
  });
}
