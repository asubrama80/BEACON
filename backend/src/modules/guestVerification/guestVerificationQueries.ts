import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { guestOtpChallenges, guestSessions, type DbOrTx } from "@beacon/database";

export interface InsertChallengeInput {
  invitationId: string;
  codeSalt: string;
  codeHash: string;
  expiresAt: Date;
}

/** Supersedes any still-active challenge for this invitation before inserting the new one — the
 * two must happen together (same transaction) so a resend genuinely invalidates the prior OTP. */
export async function supersedeActiveChallenges(db: DbOrTx, invitationId: string): Promise<void> {
  await db
    .update(guestOtpChallenges)
    .set({ status: "superseded" })
    .where(and(eq(guestOtpChallenges.invitationId, invitationId), eq(guestOtpChallenges.status, "active")));
}

export async function insertChallenge(db: DbOrTx, input: InsertChallengeInput): Promise<{ id: string; issuedAt: Date }> {
  const [row] = await db
    .insert(guestOtpChallenges)
    .values({
      invitationId: input.invitationId,
      codeSalt: input.codeSalt,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
    })
    .returning({ id: guestOtpChallenges.id, issuedAt: guestOtpChallenges.issuedAt });
  if (!row) throw new Error("Failed to create OTP challenge.");
  return row;
}

export interface ActiveChallengeRow {
  id: string;
  codeSalt: string;
  codeHash: string;
  status: string;
  attemptCount: number;
  issuedAt: Date;
  expiresAt: Date;
}

export async function findActiveChallenge(db: DbOrTx, invitationId: string): Promise<ActiveChallengeRow | undefined> {
  const [row] = await db
    .select({
      id: guestOtpChallenges.id,
      codeSalt: guestOtpChallenges.codeSalt,
      codeHash: guestOtpChallenges.codeHash,
      status: guestOtpChallenges.status,
      attemptCount: guestOtpChallenges.attemptCount,
      issuedAt: guestOtpChallenges.issuedAt,
      expiresAt: guestOtpChallenges.expiresAt,
    })
    .from(guestOtpChallenges)
    .where(and(eq(guestOtpChallenges.invitationId, invitationId), eq(guestOtpChallenges.status, "active")))
    .limit(1);
  return row;
}

/**
 * Increments the attempt counter and, once it reaches `maxAttempts`, locks the challenge in the
 * same call (a second UPDATE, still well within the caller's enclosing transaction) — never
 * discloses the expected code, only whether this attempt was wrong and whether the challenge is
 * now locked.
 */
export async function recordFailedAttempt(
  db: DbOrTx,
  challengeId: string,
  maxAttempts: number,
): Promise<{ attemptCount: number; lockedNow: boolean }> {
  const [incremented] = await db
    .update(guestOtpChallenges)
    .set({ attemptCount: sql`${guestOtpChallenges.attemptCount} + 1` })
    .where(eq(guestOtpChallenges.id, challengeId))
    .returning({ attemptCount: guestOtpChallenges.attemptCount });
  if (!incremented) throw new Error("Failed to record OTP attempt.");

  if (incremented.attemptCount >= maxAttempts) {
    await db
      .update(guestOtpChallenges)
      .set({ status: "locked" })
      .where(and(eq(guestOtpChallenges.id, challengeId), eq(guestOtpChallenges.status, "active")));
    return { attemptCount: incremented.attemptCount, lockedNow: true };
  }
  return { attemptCount: incremented.attemptCount, lockedNow: false };
}

/** Conditional UPDATE — only succeeds against a still-ACTIVE challenge, making this the real
 * concurrency guard for two simultaneous correct-code submissions (see
 * claude/prompts/18-otp-verification.md, "Concurrent verification"). */
export async function consumeChallenge(db: DbOrTx, challengeId: string): Promise<boolean> {
  const result = await db
    .update(guestOtpChallenges)
    .set({ status: "consumed", consumedAt: new Date() })
    .where(and(eq(guestOtpChallenges.id, challengeId), eq(guestOtpChallenges.status, "active")))
    .returning({ id: guestOtpChallenges.id });
  return result.length > 0;
}

export async function getChallengeStatus(db: DbOrTx, challengeId: string): Promise<string | undefined> {
  const [row] = await db.select({ status: guestOtpChallenges.status }).from(guestOtpChallenges).where(eq(guestOtpChallenges.id, challengeId)).limit(1);
  return row?.status;
}

export interface InsertGuestSessionInput {
  invitationId: string;
  tokenHash: string;
  expiresAt: Date;
}

export async function insertGuestSession(db: DbOrTx, input: InsertGuestSessionInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(guestSessions)
    .values({ invitationId: input.invitationId, tokenHash: input.tokenHash, expiresAt: input.expiresAt })
    .returning({ id: guestSessions.id });
  if (!row) throw new Error("Failed to create guest session.");
  return row;
}

export interface ActiveGuestSessionRow {
  id: string;
  invitationId: string;
}

export async function findActiveGuestSessionByTokenHash(db: DbOrTx, tokenHash: string, now: Date): Promise<ActiveGuestSessionRow | undefined> {
  const [row] = await db
    .select({ id: guestSessions.id, invitationId: guestSessions.invitationId })
    .from(guestSessions)
    .where(and(eq(guestSessions.tokenHash, tokenHash), isNull(guestSessions.revokedAt), gt(guestSessions.expiresAt, now)))
    .limit(1);
  return row;
}

export async function revokeGuestSession(db: DbOrTx, id: string): Promise<void> {
  await db.update(guestSessions).set({ revokedAt: new Date() }).where(eq(guestSessions.id, id));
}

/**
 * Module 19 — revokes every currently-active session for an invitation in one call, used when a
 * manager removes a Guest from the participant roster (see `incidents/service.ts`'s
 * `removeParticipant()`). This is the actual mechanism that makes removal immediate:
 * `authenticateGuest()` looks up the session by its (unchanged) cookie token, and a revoked
 * session row simply no longer matches `findActiveGuestSessionByTokenHash()`'s `revoked_at IS
 * NULL` condition — no separate participant-status check is needed there.
 */
export async function revokeAllGuestSessionsForInvitation(db: DbOrTx, invitationId: string): Promise<void> {
  await db
    .update(guestSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(guestSessions.invitationId, invitationId), isNull(guestSessions.revokedAt)));
}

export async function touchGuestSession(db: DbOrTx, id: string, now: Date): Promise<void> {
  await db.update(guestSessions).set({ lastSeenAt: now }).where(eq(guestSessions.id, id));
}
