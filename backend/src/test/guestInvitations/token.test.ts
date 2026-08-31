import { describe, expect, it } from "vitest";
import { generateInvitationToken, hashInvitationToken } from "../../modules/guestInvitations/token.js";

describe("guest invitation tokens", () => {
  it("generates high-entropy, unique tokens", () => {
    const a = generateInvitationToken();
    const b = generateInvitationToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });

  it("hashes deterministically (same token -> same hash)", () => {
    const token = generateInvitationToken();
    expect(hashInvitationToken(token)).toBe(hashInvitationToken(token));
  });

  it("produces different hashes for different tokens", () => {
    expect(hashInvitationToken(generateInvitationToken())).not.toBe(hashInvitationToken(generateInvitationToken()));
  });

  it("never stores/exposes the raw token from its hash (one-way)", () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);
    expect(hash).not.toContain(token);
    expect(hash).toHaveLength(64); // hex-encoded SHA-256
  });
});
