export type AuthErrorCode =
  | "invalid_request"
  | "invalid_credentials"
  | "mfa_required"
  | "invalid_mfa_code"
  | "too_many_attempts"
  | "not_authenticated"
  | "not_authorized"
  | "csrf_invalid"
  | "mfa_already_enabled"
  | "mfa_enrollment_not_found"
  | "mfa_not_enabled"
  | "last_admin_protected"
  | "break_glass_protected"
  | "duplicate_email"
  | "not_found"
  | "role_not_found"
  | "role_already_assigned"
  | "likely_duplicate"
  | "import_file_invalid"
  | "import_mapping_invalid"
  | "import_batch_expired"
  | "import_batch_not_previewable"
  | "duplicate_group_name"
  | "duplicate_template_name"
  | "invalid_transition"
  | "incident_closed"
  | "duplicate_participant";

/**
 * A deliberately generic, safe error surfaced to the client — never a stack trace or DB
 * detail. Despite the name, this is the shared error type for both authentication (401:
 * "who are you?") and authorization (403: "what are you allowed to do?", Module 03's RBAC)
 * failures — `app.ts`'s single global error handler already special-cases `instanceof
 * AuthError`, so both pipelines reuse it rather than each inventing a parallel error class.
 */
export class AuthError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: AuthErrorCode,
    message: string,
    /** Optional safe, structured extra context (e.g. Module 04's likely-duplicate matches). */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AuthError";
  }

  toResponse(): { error: AuthErrorCode; message: string } & Record<string, unknown> {
    return { error: this.code, message: this.message, ...(this.details ?? {}) };
  }
}

export const INVALID_CREDENTIALS = new AuthError(401, "invalid_credentials", "Invalid email or password.");
export const TOO_MANY_ATTEMPTS = new AuthError(
  401,
  "too_many_attempts",
  "Too many failed attempts. Try again later.",
);
export const MFA_REQUIRED = new AuthError(
  401,
  "mfa_required",
  "Multi-factor authentication code required.",
);
export const INVALID_MFA_CODE = new AuthError(401, "invalid_mfa_code", "Invalid verification code.");
export const NOT_AUTHENTICATED = new AuthError(401, "not_authenticated", "Authentication required.");
export const NOT_AUTHORIZED = new AuthError(403, "not_authorized", "You do not have permission to do that.");
export const CSRF_INVALID = new AuthError(403, "csrf_invalid", "Request could not be verified.");
