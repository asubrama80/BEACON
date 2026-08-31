import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GuestLandingPage from "./GuestLandingPage";

function mockRoutes(overrides: Record<string, (input: RequestInit | undefined) => { status?: number; body: unknown }> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      const normalizedPath = path.startsWith("/guest/invitations/") ? path.replace(/\/guest\/invitations\/[^/]+/, "/guest/invitations/:token") : path;
      const key = `${method} ${normalizedPath}`;
      const match = overrides[key];
      if (match) {
        const result = match(init);
        return Promise.resolve({ ok: (result.status ?? 200) < 300, status: result.status ?? 200, json: () => Promise.resolve(result.body) });
      }
      // Default: no existing Guest session.
      if (path === "/guest/session") {
        return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: "not_authenticated" }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }),
  );
}

describe("GuestLandingPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the Incident context and masked destination for a valid invitation", async () => {
    mockRoutes({
      "GET /guest/invitations/:token": () => ({
        body: {
          valid: true,
          incidentNumber: "INC-2026-000001",
          incidentTitle: "Server Outage",
          guestName: "Jane Guest",
          maskedDestination: "j***@example.invalid",
        },
      }),
    });
    render(<GuestLandingPage token="raw-token-value" />);

    await screen.findByText("INC-2026-000001 — Server Outage");
    expect(screen.getByText(/Jane Guest/)).toBeInTheDocument();
    expect(screen.getByText(/j\*\*\*@example\.invalid/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("raw-token-value");
  });

  it("shows a generic message for an expired invitation, without leaking internal detail", async () => {
    mockRoutes({ "GET /guest/invitations/:token": () => ({ body: { valid: false, reason: "expired" } }) });
    render(<GuestLandingPage token="raw-token-value" />);
    await screen.findByText(/expired/i);
  });

  it("shows a generic message for an unknown token", async () => {
    mockRoutes({ "GET /guest/invitations/:token": () => ({ body: { valid: false, reason: "not_found" } }) });
    render(<GuestLandingPage token="does-not-exist" />);
    await screen.findByText(/not valid/i);
  });

  it("requests a code, shows the masked-destination confirmation, and lets the guest enter one", async () => {
    mockRoutes({
      "GET /guest/invitations/:token": () => ({
        body: { valid: true, incidentNumber: "INC-1", incidentTitle: "T", guestName: "G", maskedDestination: "g***@example.invalid" },
      }),
      "POST /guest/invitations/:token/otp/request": () => ({
        body: { maskedDestination: "g***@example.invalid", resendAvailableAt: "2026-01-01T00:01:00.000Z", otpExpiresAt: "2026-01-01T00:10:00.000Z" },
      }),
    });
    render(<GuestLandingPage token="raw-token-value" />);
    fireEvent.click(await screen.findByRole("button", { name: "Begin Verification" }));

    await screen.findByText(/Code sent to g\*\*\*@example\.invalid/);
    expect(screen.getByLabelText("6-digit code")).toBeInTheDocument();
  });

  it("verifies the code and shows the authenticated Guest confirmation, without ever exposing the code", async () => {
    mockRoutes({
      "GET /guest/invitations/:token": () => ({
        body: { valid: true, incidentNumber: "INC-1", incidentTitle: "T", guestName: "Jane Guest", maskedDestination: "j***@example.invalid" },
      }),
      "POST /guest/invitations/:token/otp/request": () => ({
        body: { maskedDestination: "j***@example.invalid", resendAvailableAt: "2026-01-01T00:01:00.000Z", otpExpiresAt: "2026-01-01T00:10:00.000Z" },
      }),
      "POST /guest/invitations/:token/otp/verify": () => ({
        body: { guestName: "Jane Guest", incidentId: "incident-1", sessionExpiresAt: "2026-01-01T12:00:00.000Z" },
      }),
    });
    render(<GuestLandingPage token="raw-token-value" />);
    fireEvent.click(await screen.findByRole("button", { name: "Begin Verification" }));
    await screen.findByLabelText("6-digit code");

    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(screen.getByText(/Welcome, Jane Guest/)).toBeInTheDocument());
    expect(document.body.textContent).not.toContain("123456");
  });

  it("shows an inline error for a wrong code and stays on the entry form", async () => {
    mockRoutes({
      "GET /guest/invitations/:token": () => ({
        body: { valid: true, incidentNumber: "INC-1", incidentTitle: "T", guestName: "G", maskedDestination: "g***@example.invalid" },
      }),
      "POST /guest/invitations/:token/otp/request": () => ({
        body: { maskedDestination: "g***@example.invalid", resendAvailableAt: "2026-01-01T00:01:00.000Z", otpExpiresAt: "2026-01-01T00:10:00.000Z" },
      }),
      "POST /guest/invitations/:token/otp/verify": () => ({ status: 400, body: { error: "otp_invalid", message: "That code is incorrect." } }),
    });
    render(<GuestLandingPage token="raw-token-value" />);
    fireEvent.click(await screen.findByRole("button", { name: "Begin Verification" }));
    await screen.findByLabelText("6-digit code");
    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await screen.findByText("That code is incorrect.");
    expect(screen.getByLabelText("6-digit code")).toBeInTheDocument();
  });

  it("restores the verified view on refresh when a valid Guest session already exists", async () => {
    mockRoutes({
      "GET /guest/session": () => ({ body: { guestName: "Jane Guest", incidentId: "incident-1", capabilities: { chat: true, warRoom: false } } }),
    });
    render(<GuestLandingPage token="raw-token-value" />);
    await screen.findByText(/Welcome, Jane Guest/);
  });
});
