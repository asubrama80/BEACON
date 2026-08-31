import { randomBytes, createHash } from "node:crypto";

/**
 * High-entropy opaque invitation token — the raw value is only ever handed to the caller once
 * (to build the invitation link/notification), and only its hash is persisted. Mirrors the exact
 * pattern already established for BEACON session tokens (`auth/session.ts`). See
 * claude/prompts/17-guest-invitations.md, "Token security".
 */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
