import { randomBytes, createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { mfaRecoveryCodes, type Database } from "@beacon/database";

const RECOVERY_CODE_COUNT = 10;

function generateOneCode(): string {
  // 8 random bytes (64 bits of entropy) formatted as four 4-char hex groups, e.g. a1b2-c3d4-e5f6-0718
  const hex = randomBytes(8).toString("hex");
  return [hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12), hex.slice(12, 16)].join("-");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}

/**
 * Generates a fresh batch of plaintext recovery codes and persists only their hashes.
 * Deletes any existing codes for the user first, so regenerating always invalidates the old set.
 */
export async function regenerateRecoveryCodes(db: Database, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateOneCode);

  await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
  await db.insert(mfaRecoveryCodes).values(
    codes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })),
  );

  return codes;
}

/**
 * Verifies a submitted recovery code and, if valid and unused, marks it consumed — as a
 * single atomic conditional UPDATE (not a select-then-update), so two concurrent requests
 * racing to use the same code cannot both succeed: Postgres serializes the row update, and
 * only the first one finds `used_at IS NULL` still true. Returns false for an already-used
 * or unknown code — codes are strictly one-time use.
 */
export async function consumeRecoveryCode(
  db: Database,
  userId: string,
  submittedCode: string,
): Promise<boolean> {
  const codeHash = hashRecoveryCode(submittedCode);

  const updated = await db
    .update(mfaRecoveryCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(mfaRecoveryCodes.userId, userId),
        eq(mfaRecoveryCodes.codeHash, codeHash),
        isNull(mfaRecoveryCodes.usedAt),
      ),
    )
    .returning({ id: mfaRecoveryCodes.id });

  return updated.length > 0;
}
