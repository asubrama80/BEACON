import type { AuthConfig } from "./config.js";

// Small blocklist of extremely common passwords. Not exhaustive by design — this is a basic
// safety net for administrator-driven account creation, not a full breached-password check.
const COMMON_PASSWORDS = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyuiop",
  "letmein123",
  "welcome123",
  "admin12345",
  "changeme123",
  "beaconbeacon",
]);

export interface PasswordPolicyContext {
  email: string;
  displayName: string;
}

export interface PasswordPolicyResult {
  valid: boolean;
  reason?: string;
}

export function validatePasswordPolicy(
  password: string,
  context: PasswordPolicyContext,
  config: AuthConfig,
): PasswordPolicyResult {
  if (password.length < config.passwordMinLength) {
    return { valid: false, reason: `Password must be at least ${config.passwordMinLength} characters.` };
  }

  const normalized = password.trim().toLowerCase();

  if (COMMON_PASSWORDS.has(normalized)) {
    return { valid: false, reason: "Password is too common. Choose a less predictable password." };
  }

  const emailLocalPart = context.email.split("@")[0]?.toLowerCase() ?? "";
  if (normalized === context.email.toLowerCase() || (emailLocalPart && normalized === emailLocalPart)) {
    return { valid: false, reason: "Password must not match the account email." };
  }

  if (context.displayName.trim() && normalized === context.displayName.trim().toLowerCase()) {
    return { valid: false, reason: "Password must not match the account name." };
  }

  return { valid: true };
}
