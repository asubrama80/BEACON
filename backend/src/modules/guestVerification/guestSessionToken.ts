import { randomBytes, createHash } from "node:crypto";

/**
 * Mirrors `auth/session.ts`'s registered-User session-token pattern exactly, but is a wholly
 * separate token space — a Guest session token is never valid against `authenticateUser()` and a
 * User session token is never valid against `authenticateGuest()`.
 */
export function generateGuestSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashGuestSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
