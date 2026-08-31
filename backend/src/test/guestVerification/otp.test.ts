import { describe, expect, it } from "vitest";
import { generateOtp, generateOtpSalt, hashOtp, verifyOtp } from "../../modules/guestVerification/otp.js";

describe("OTP generation and hashing", () => {
  it("generates a 6-digit numeric code", () => {
    const code = generateOtp();
    expect(code).toMatch(/^[0-9]{6}$/);
  });

  it("generates different codes across many calls (not a static/demo value)", () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateOtp()));
    expect(codes.size).toBeGreaterThan(1);
    expect(codes.has("482615")).toBe(false); // the prototype's static demo code must never appear
  });

  it("hashes deterministically for the same code+salt", () => {
    const salt = generateOtpSalt();
    expect(hashOtp("123456", salt)).toBe(hashOtp("123456", salt));
  });

  it("produces different hashes for the same code with different salts", () => {
    expect(hashOtp("123456", generateOtpSalt())).not.toBe(hashOtp("123456", generateOtpSalt()));
  });

  it("never stores/exposes the raw code from its hash (one-way)", () => {
    const salt = generateOtpSalt();
    const hash = hashOtp("123456", salt);
    expect(hash).not.toContain("123456");
    expect(hash).toHaveLength(64); // hex-encoded SHA-256
  });

  it("verifyOtp correctly accepts the right code and rejects a wrong one", () => {
    const salt = generateOtpSalt();
    const hash = hashOtp("123456", salt);
    expect(verifyOtp("123456", salt, hash)).toBe(true);
    expect(verifyOtp("654321", salt, hash)).toBe(false);
  });
});
