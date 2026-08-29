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
            roles: ["RESPONDER"],
            permissions: [],
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

  it("does not show Users navigation for a user without users.read", async () => {
    mockAuthMe({
      ok: true,
      json: () =>
        Promise.resolve({
          user: {
            id: "22222222-2222-2222-2222-222222222222",
            email: "responder@example.invalid",
            displayName: "No Permission Responder",
            status: "active",
            isBreakGlass: false,
            mfaEnabled: false,
            roles: ["RESPONDER"],
            permissions: [],
          },
        }),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Signed in")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Users" })).not.toBeInTheDocument();
  });

  it("shows Users navigation for a user with users.read and can reach the page", async () => {
    mockAuthMe({
      ok: true,
      json: () =>
        Promise.resolve({
          user: {
            id: "33333333-3333-3333-3333-333333333333",
            email: "admin@example.invalid",
            displayName: "Admin User",
            status: "active",
            isBreakGlass: false,
            mfaEnabled: false,
            roles: ["ADMIN"],
            permissions: ["users.read", "users.create"],
          },
        }),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const path = new URL(String(input)).pathname;
        if (path === "/auth/me") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                user: {
                  id: "33333333-3333-3333-3333-333333333333",
                  email: "admin@example.invalid",
                  displayName: "Admin User",
                  status: "active",
                  isBreakGlass: false,
                  mfaEnabled: false,
                  roles: ["ADMIN"],
                  permissions: ["users.read", "users.create"],
                },
              }),
          });
        }
        if (path === "/users") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 25 }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    render(<App />);

    const usersNavButton = await screen.findByRole("button", { name: "Users" });
    usersNavButton.click();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: "Users" })).toBeInTheDocument();
    });
  });
});
