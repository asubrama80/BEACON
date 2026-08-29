import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, getDummyHash } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

const config = loadAuthConfig({ ARGON2_MEMORY_COST: "8192", ARGON2_TIME_COST: "1", ARGON2_PARALLELISM: "1" });

describe("password hashing", () => {
  it("hashes with an argon2id PHC-formatted hash and never stores plaintext", async () => {
    const hash = await hashPassword("Correct-Horse-Battery-Staple-1", config);

    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain("Correct-Horse-Battery-Staple-1");
  });

  it("verifies a correct password", async () => {
    const hash = await hashPassword("Correct-Horse-Battery-Staple-1", config);
    expect(await verifyPassword(hash, "Correct-Horse-Battery-Staple-1")).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("Correct-Horse-Battery-Staple-1", config);
    expect(await verifyPassword(hash, "wrong-password")).toBe(false);
  });

  it("produces different hashes for the same password (random salt)", async () => {
    const [a, b] = await Promise.all([
      hashPassword("same-password-123456", config),
      hashPassword("same-password-123456", config),
    ]);
    expect(a).not.toBe(b);
  });

  it("treats a malformed hash as a non-match rather than throwing", async () => {
    await expect(verifyPassword("not-a-real-hash", "anything")).resolves.toBe(false);
  });

  it("exposes a stable dummy hash usable for timing-safe comparisons", async () => {
    const dummy = await getDummyHash(config);
    expect(dummy).toMatch(/^\$argon2id\$/);
  });
});
