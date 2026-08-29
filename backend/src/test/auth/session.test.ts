import { describe, expect, it } from "vitest";
import { generateSessionToken, hashSessionToken, safeEqual } from "../../modules/auth/session.js";

describe("session tokens", () => {
  it("generates high-entropy, unique tokens", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });

  it("hashes deterministically (same token -> same hash)", () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it("produces different hashes for different tokens", () => {
    expect(hashSessionToken(generateSessionToken())).not.toBe(hashSessionToken(generateSessionToken()));
  });

  it("never stores/exposes the raw token from its hash (one-way)", () => {
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64); // hex-encoded SHA-256
  });
});

describe("safeEqual", () => {
  it("returns true for identical strings", () => {
    expect(safeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(safeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false for different-length strings without throwing", () => {
    expect(safeEqual("short", "a-much-longer-string")).toBe(false);
  });
});
