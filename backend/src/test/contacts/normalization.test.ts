import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizePhone } from "../../modules/contacts/normalization.js";

describe("normalizeEmail", () => {
  it("trims and lowercases a valid email", () => {
    const result = normalizeEmail("  Jane.Doe@Example.COM  ");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("jane.doe@example.com");
  });

  it("rejects an empty value", () => {
    expect(normalizeEmail("   ").valid).toBe(false);
  });

  it("rejects a clearly malformed email rather than coercing it", () => {
    const result = normalizeEmail("not-an-email");
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("rejects an email missing a domain", () => {
    expect(normalizeEmail("jane@").valid).toBe(false);
  });

  it("rejects an email longer than 255 characters", () => {
    const long = `${"a".repeat(250)}@example.com`;
    expect(normalizeEmail(long).valid).toBe(false);
  });
});

describe("normalizePhone", () => {
  it("normalizes a bare 10-digit US number to E.164", () => {
    const result = normalizePhone("2124567890");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("+12124567890");
  });

  it("normalizes a formatted US number to the same E.164 value", () => {
    const result = normalizePhone("(212) 456-7890");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("+12124567890");
  });

  it("respects an explicit international number rather than forcing a US country code", () => {
    const result = normalizePhone("+442071838750");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("+442071838750");
  });

  it("rejects an empty value", () => {
    expect(normalizePhone("   ").valid).toBe(false);
  });

  it("rejects a clearly invalid number rather than storing a plausible-looking guess", () => {
    const result = normalizePhone("123");
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("rejects non-numeric garbage without throwing", () => {
    const result = normalizePhone("not-a-phone-number");
    expect(result.valid).toBe(false);
  });
});
