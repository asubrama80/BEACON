import { auditLogs, type Database } from "@beacon/database";

export type AuthAuditEventType =
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILURE"
  | "LOGOUT"
  | "MFA_ENROLLED"
  | "MFA_VERIFIED"
  | "MFA_DISABLED"
  | "MFA_RECOVERY_CODES_REGENERATED"
  | "RECOVERY_CODE_USED"
  | "BREAK_GLASS_LOGIN";

export interface RecordAuthEventInput {
  eventType: AuthAuditEventType;
  /** Set for events tied to a known user; omit for e.g. a failed login against an unknown email. */
  actorId?: string;
  /**
   * Safe, non-secret context only (e.g. a failure reason code, an attempted email). Never
   * passwords, hashes, MFA secrets, OTPs, recovery codes, or raw session tokens.
   */
  metadata?: Record<string, unknown>;
}

export async function recordAuthEvent(db: Database, input: RecordAuthEventInput): Promise<void> {
  await db.insert(auditLogs).values({
    eventType: input.eventType,
    actorType: input.actorId ? "user" : "system",
    actorId: input.actorId,
    metadata: input.metadata ?? {},
  });
}
