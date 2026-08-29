import { describe, expect, it } from "vitest";
import { validatePasswordPolicy } from "../../modules/auth/passwordPolicy.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

const config = loadAuthConfig({ PASSWORD_MIN_LENGTH: "12" });
const context = { email: "responder@example.invalid", displayName: "Jane Responder" };

describe("validatePasswordPolicy", () => {
  it("rejects passwords shorter than the configured minimum", () => {
    const result = validatePasswordPolicy("short1234", context, config);
    expect(result.valid).toBe(false);
  });

  it("rejects a common weak password", () => {
    const result = validatePasswordPolicy("password123", context, config);
    expect(result.valid).toBe(false);
  });

  it("rejects a password matching the account email", () => {
    const result = validatePasswordPolicy(context.email, context, config);
    expect(result.valid).toBe(false);
  });

  it("rejects a password matching the account display name", () => {
    const result = validatePasswordPolicy("Jane Responder", context, config);
    expect(result.valid).toBe(false);
  });

  it("accepts a reasonable password", () => {
    const result = validatePasswordPolicy("Correct-Horse-Battery-Staple-99", context, config);
    expect(result.valid).toBe(true);
  });
});
