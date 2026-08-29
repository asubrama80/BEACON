import { describe, expect, it } from "vitest";
import { LoginThrottle } from "../../modules/auth/loginThrottle.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

const config = loadAuthConfig({ LOGIN_MAX_FAILURES: "3", LOGIN_LOCKOUT_WINDOW_MINUTES: "15" });

describe("LoginThrottle", () => {
  it("is not locked before the failure threshold is reached", () => {
    const throttle = new LoginThrottle(config);
    throttle.recordFailure("user@example.invalid");
    throttle.recordFailure("user@example.invalid");
    expect(throttle.isLocked("user@example.invalid")).toBe(false);
  });

  it("locks after reaching the configured max failures", () => {
    const throttle = new LoginThrottle(config);
    throttle.recordFailure("user@example.invalid");
    throttle.recordFailure("user@example.invalid");
    throttle.recordFailure("user@example.invalid");
    expect(throttle.isLocked("user@example.invalid")).toBe(true);
  });

  it("applies identically to an email that doesn't correspond to any real account", () => {
    const throttle = new LoginThrottle(config);
    throttle.recordFailure("nobody-real@example.invalid");
    throttle.recordFailure("nobody-real@example.invalid");
    throttle.recordFailure("nobody-real@example.invalid");
    expect(throttle.isLocked("nobody-real@example.invalid")).toBe(true);
  });

  it("normalizes email case/whitespace to the same throttle key", () => {
    const throttle = new LoginThrottle(config);
    throttle.recordFailure("  User@Example.Invalid  ");
    throttle.recordFailure("user@example.invalid");
    throttle.recordFailure("USER@EXAMPLE.INVALID");
    expect(throttle.isLocked("user@example.invalid")).toBe(true);
  });

  it("clears the lock on a recorded success", () => {
    const throttle = new LoginThrottle(config);
    throttle.recordFailure("user@example.invalid");
    throttle.recordFailure("user@example.invalid");
    throttle.recordFailure("user@example.invalid");
    expect(throttle.isLocked("user@example.invalid")).toBe(true);

    throttle.recordSuccess("user@example.invalid");
    expect(throttle.isLocked("user@example.invalid")).toBe(false);
  });

  it("does not lock an unrelated email", () => {
    const throttle = new LoginThrottle(config);
    throttle.recordFailure("user-a@example.invalid");
    throttle.recordFailure("user-a@example.invalid");
    throttle.recordFailure("user-a@example.invalid");
    expect(throttle.isLocked("user-b@example.invalid")).toBe(false);
  });
});
