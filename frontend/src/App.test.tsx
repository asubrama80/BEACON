import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

function mockAuthMe(response: { ok: boolean; json: () => Promise<unknown> }): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

describe("App", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the login screen when there is no session", async () => {
    mockAuthMe({ ok: false, json: () => Promise.resolve({ error: "not_authenticated" }) });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "BEACON" })).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("shows the authenticated shell when a session exists", async () => {
    mockAuthMe({
      ok: true,
      json: () =>
        Promise.resolve({
          user: {
            id: "11111111-1111-1111-1111-111111111111",
            email: "jane@example.invalid",
            displayName: "Jane Responder",
            status: "active",
            isBreakGlass: false,
            mfaEnabled: false,
          },
        }),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Signed in")).toBeInTheDocument();
    });
    expect(screen.getByText("Jane Responder")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });
});
