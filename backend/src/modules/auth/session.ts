import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { sessions, type Database } from "@beacon/database";
import type { AuthConfig } from "./config.js";

/** Generates a high-entropy opaque session token. Never persisted — only its hash is stored. */
export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

/**
 * Creates a brand-new session row (never reuses/upgrades an existing token — a successful
 * login always starts a fresh session, which is the session-fixation defense for this design).
 * Opportunistically prunes long-expired/revoked rows so the table doesn't grow unbounded
 * without needing a separate scheduled job.
 */
export async function createSession(
  db: Database,
  userId: string,
  config: AuthConfig,
): Promise<CreatedSession> {
  const token = generateSessionToken();
  const tokenHash = hashSessionToken(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.sessionTtlSeconds * 1000);

  await db.insert(sessions).values({ userId, tokenHash, expiresAt });

  const pruneCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  await db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, pruneCutoff), lt(sessions.revokedAt, pruneCutoff)))
    .catch(() => {
      // Best-effort cleanup only; never let it fail the login itself.
    });

  return { token, expiresAt };
}

export interface ActiveSession {
  id: string;
  userId: string;
}

/** Looks up a still-valid (unexpired, unrevoked) session by its raw token. */
export async function findActiveSessionByToken(
  db: Database,
  token: string,
): Promise<ActiveSession | undefined> {
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  const [row] = await db
    .select({ id: sessions.id, userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
    .limit(1);

  if (row) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.id));
  }

  return row;
}

export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

/**
 * Revokes every currently-active session for a user — used when disabling a user or resetting
 * their password (Module 03), so access is cut immediately rather than waiting for expiry.
 * Re-enabling a user never restores these; a fresh login is required.
 */
export async function revokeAllSessionsForUser(db: Database, userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

/** Constant-time comparison, used for CSRF token checks. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}
