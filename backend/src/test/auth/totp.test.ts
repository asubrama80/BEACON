import { randomBytes } from "node:crypto";
import { TOTP, Secret } from "otpauth";
import { describe, expect, it } from "vitest";
import {
  generateTotpSecret,
  encryptTotpSecret,
  decryptTotpSecret,
  buildOtpauthUrl,
  verifyTotpCode,
} from "../../modules/auth/totp.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

const config = loadAuthConfig({ MFA_ISSUER: "BEACON Test" });
const key = randomBytes(32);

function currentCodeFor(secretBase32: string): string {
  return new TOTP({
    secret: Secret.fromBase32(secretBase32),
    algorithm: "SHA1",
    digits: 6,
    period: 30,
  }).generate();
}

describe("TOTP secret lifecycle", () => {
  it("generates a base32 secret", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  });

  it("round-trips through AES-256-GCM encryption", () => {
    const secret = generateTotpSecret();
    const ciphertext = encryptTotpSecret(secret, key);
    expect(ciphertext).not.toContain(secret);
    expect(decryptTotpSecret(ciphertext, key)).toBe(secret);
  });

  it("fails to decrypt with the wrong key (authenticity check)", () => {
    const secret = generateTotpSecret();
    const ciphertext = encryptTotpSecret(secret, key);
    const wrongKey = randomBytes(32);
    expect(() => decryptTotpSecret(ciphertext, wrongKey)).toThrow();
  });

  it("builds a valid otpauth:// URL carrying the issuer", () => {
    const secret = generateTotpSecret();
    const url = buildOtpauthUrl(secret, "user@example.invalid", config);
    expect(url).toMatch(/^otpauth:\/\/totp\//);
    expect(url).toContain(encodeURIComponent("BEACON Test"));
  });
});

describe("verifyTotpCode", () => {
  it("accepts the current valid code", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, currentCodeFor(secret))).toBe(true);
  });

  it("rejects an incorrect code", () => {
    const secret = generateTotpSecret();
    const valid = currentCodeFor(secret);
    const wrong = valid === "000000" ? "111111" : "000000";
    expect(verifyTotpCode(secret, wrong)).toBe(false);
  });

  it("rejects a non-6-digit input", () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(secret, "12345")).toBe(false);
    expect(verifyTotpCode(secret, "abcdef")).toBe(false);
  });
});
