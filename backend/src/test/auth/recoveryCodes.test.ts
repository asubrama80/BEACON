import { describe, expect, it } from "vitest";
import { hashRecoveryCode } from "../../modules/auth/recoveryCodes.js";

describe("hashRecoveryCode", () => {
  it("hashes deterministically regardless of case/whitespace", () => {
    const a = hashRecoveryCode("a1b2-c3d4-e5f6-0718");
    const b = hashRecoveryCode("  A1B2-C3D4-E5F6-0718  ");
    expect(a).toBe(b);
  });

  it("produces different hashes for different codes", () => {
    expect(hashRecoveryCode("a1b2-c3d4-e5f6-0718")).not.toBe(hashRecoveryCode("1111-2222-3333-4444"));
  });

  it("never contains the original code (one-way)", () => {
    const code = "a1b2-c3d4-e5f6-0718";
    expect(hashRecoveryCode(code)).not.toContain(code);
  });
});
