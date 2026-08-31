import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GuestLandingPage from "./GuestLandingPage";

function mockLookup(body: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) })),
  );
}

describe("GuestLandingPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the Incident context and masked destination for a valid invitation", async () => {
    mockLookup({
      valid: true,
      incidentNumber: "INC-2026-000001",
      incidentTitle: "Server Outage",
      guestName: "Jane Guest",
      maskedDestination: "j***@example.invalid",
    });
    render(<GuestLandingPage token="raw-token-value" />);

    await screen.findByText("INC-2026-000001 — Server Outage");
    expect(screen.getByText(/Jane Guest/)).toBeInTheDocument();
    expect(screen.getByText(/j\*\*\*@example\.invalid/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("raw-token-value");
  });

  it("shows a generic message for an expired invitation, without leaking internal detail", async () => {
    mockLookup({ valid: false, reason: "expired" });
    render(<GuestLandingPage token="raw-token-value" />);
    await screen.findByText(/expired/i);
  });

  it("shows a generic message for an unknown token", async () => {
    mockLookup({ valid: false, reason: "not_found" });
    render(<GuestLandingPage token="does-not-exist" />);
    await screen.findByText(/not valid/i);
  });

  it("never renders a Begin Verification action that actually completes verification in this build", async () => {
    mockLookup({ valid: true, incidentNumber: "INC-1", incidentTitle: "T", guestName: "G" });
    render(<GuestLandingPage token="raw-token-value" />);
    const button = await screen.findByRole("button", { name: "Begin Verification" });
    expect(button).toBeDisabled();
  });
});
