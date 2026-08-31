import { randomInt, randomBytes, createHash } from "node:crypto";
import { safeEqual } from "../auth/session.js";

/**
 * Cryptographically secure 6-digit numeric code via `crypto.randomInt` (CSPRNG-backed) —
 * deliberately never `Math.random()`, and never a static/demo value. "Prototype demo value must
 * never become production logic." See claude/prompts/18-otp-verification.md, "OTP generation".
 */
export function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export function generateOtpSalt(): string {
  return randomBytes(16).toString("hex");
}

export function hashOtp(code: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

/** Constant-time comparison — never a plain `===` on the recomputed hash. */
export function verifyOtp(code: string, salt: string, storedHash: string): boolean {
  return safeEqual(hashOtp(code, salt), storedHash);
}
