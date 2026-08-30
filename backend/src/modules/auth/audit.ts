import { auditLogs, type DbOrTx } from "@beacon/database";

export type AuthAuditEventType =
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILURE"
  | "LOGOUT"
  | "MFA_ENROLLED"
  | "MFA_VERIFIED"
  | "MFA_DISABLED"
  | "MFA_RECOVERY_CODES_REGENERATED"
  | "RECOVERY_CODE_USED"
  | "BREAK_GLASS_LOGIN"
  | "USER_CREATED"
  | "USER_UPDATED"
  | "USER_DISABLED"
  | "USER_ENABLED"
  | "USER_PASSWORD_RESET"
  | "USER_ROLE_ASSIGNED"
  | "USER_ROLE_REMOVED"
  | "CONTACT_CREATED"
  | "CONTACT_UPDATED"
  | "CONTACT_DISABLED"
  | "CONTACT_ENABLED"
  | "CONTACT_IMPORT_PREVIEWED"
  | "CONTACT_IMPORT_COMPLETED"
  | "CONTACT_IMPORT_FAILED"
  | "GROUP_CREATED"
  | "GROUP_UPDATED"
  | "GROUP_DISABLED"
  | "GROUP_ENABLED"
  | "GROUP_MEMBER_ADDED"
  | "GROUP_MEMBER_REMOVED"
  | "TEMPLATE_CREATED"
  | "TEMPLATE_UPDATED"
  | "TEMPLATE_DISABLED"
  | "TEMPLATE_ENABLED"
  | "INCIDENT_CREATED"
  | "INCIDENT_UPDATED"
  | "INCIDENT_SEVERITY_CHANGED"
  | "INCIDENT_ACTIVATED"
  | "INCIDENT_RESOLVED"
  | "INCIDENT_REOPENED"
  | "INCIDENT_CLOSED"
  | "INCIDENT_COMMANDER_ASSIGNED"
  | "INCIDENT_COMMANDER_CHANGED"
  | "INCIDENT_PARTICIPANT_ADDED"
  | "INCIDENT_PARTICIPANT_REMOVED"
  | "ALERT_CREATED"
  | "ALERT_UPDATED"
  | "ALERT_READY"
  | "ALERT_CANCELLED"
  | "ALERT_DISPATCH_STARTED"
  | "ALERT_DISPATCH_COMPLETED"
  | "ALERT_DELIVERY_COMPLETED"
  | "WAR_ROOM_OPENED"
  | "WAR_ROOM_ENDED";

export interface RecordAuthEventInput {
  eventType: AuthAuditEventType;
  /** Set for events tied to a known user; omit for e.g. a failed login against an unknown email. */
  actorId?: string;
  /** The user (or other resource) this action was performed on, if different from the actor. */
  resourceId?: string;
  resourceType?: string;
  /** Set for any event that happened in the context of a specific Incident (Module 08). */
  incidentId?: string;
  /**
   * Safe, non-secret context only (e.g. a failure reason code, an attempted email, a role
   * code). Never passwords, hashes, MFA secrets, OTPs, recovery codes, or raw session tokens.
   */
  metadata?: Record<string, unknown>;
}

export async function recordAuthEvent(db: DbOrTx, input: RecordAuthEventInput): Promise<void> {
  await db.insert(auditLogs).values({
    eventType: input.eventType,
    actorType: input.actorId ? "user" : "system",
    actorId: input.actorId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    incidentId: input.incidentId,
    metadata: input.metadata ?? {},
  });
}
