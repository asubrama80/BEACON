import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { Secret, TOTP } from "otpauth";
import type { AuthConfig } from "./config.js";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

/** Generates a new random TOTP secret (base32-encoded, not yet persisted). */
export function generateTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/** Encrypts a TOTP secret for storage. Output: base64(iv || authTag || ciphertext). */
export function encryptTotpSecret(secretBase32: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(secretBase32, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptTotpSecret(ciphertextB64: string, key: Buffer): string {
  const data = Buffer.from(ciphertextB64, "base64");
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = data.subarray(IV_LENGTH + 16);

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function buildOtpauthUrl(secretBase32: string, userEmail: string, config: AuthConfig): string {
  const totp = new TOTP({
    issuer: config.mfaIssuer,
    label: userEmail,
    secret: Secret.fromBase32(secretBase32),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  });

  return totp.toString();
}

/** Verifies a submitted 6-digit code against a decrypted secret, allowing +/-1 time step of drift. */
export function verifyTotpCode(secretBase32: string, token: string): boolean {
  if (!/^\d{6}$/.test(token)) {
    return false;
  }

  const delta = TOTP.validate({
    token,
    secret: Secret.fromBase32(secretBase32),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    window: 1,
  });

  return delta !== null;
}
