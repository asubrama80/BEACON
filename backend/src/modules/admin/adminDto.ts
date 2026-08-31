/**
 * Explicit, allowlisted status shape — never a `process.env` dump, never a credential. See
 * claude/prompts/22-administration.md, "System/Security status".
 */
export interface AdminStatusDto {
  application: {
    name: string;
    /** The workspace `package.json` version — a build identifier, not a secret. */
    version: string;
    environment: string;
  };
  database: {
    connected: boolean;
  };
  security: {
    mfaAvailable: true;
    sessionTtlHours: number;
    passwordMinLength: number;
    loginMaxFailures: number;
    breakGlass: {
      /** Whether a break-glass account exists at all — never its email/credentials. */
      present: boolean;
      status: string | null;
    };
  };
  /** Provider *names* only (e.g. "mock", "twilio") — never credentials, never editable here.
   * See claude/prompts/22-administration.md, "Provider status boundary" and Module 27. */
  providers: {
    sms: string;
    email: string;
  };
  /** Module 14's foundation is provider-neutral and Modules 15/16 remain deferred — this is
   * never a real provider name, and there is no enable/disable control here. */
  collaboration: {
    status: "foundation_only";
  };
}

export interface RoleSummaryDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  permissionCodes: string[];
  userCount: number;
}

export interface RoleSummaryRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  permissionCodes: string[] | null;
  userCount: number;
}

export function toRoleSummaryDto(row: RoleSummaryRow): RoleSummaryDto {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    permissionCodes: (row.permissionCodes ?? []).filter((c): c is string => c !== null).sort(),
    userCount: row.userCount,
  };
}
