import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import UsersPage from "./UsersPage";

const ADMIN_USER = {
  id: "44444444-4444-4444-4444-444444444444",
  email: "admin@example.invalid",
  displayName: "Admin User",
  status: "active",
  isBreakGlass: false,
  mfaEnabled: false,
  roles: ["ADMIN"],
  permissions: ["users.read", "users.create"],
};

const EXISTING_USER = {
  id: "55555555-5555-5555-5555-555555555555",
  email: "existing@example.invalid",
  displayName: "Existing User",
  status: "active",
  isBreakGlass: false,
  roles: [{ id: "r1", code: "RESPONDER", name: "Responder" }],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function mockRoutes(overrides: Record<string, () => unknown> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      const key = `${method} ${path}`;

      if (overrides[key]) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(overrides[key]!()) });
      }
      if (path === "/auth/me") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: ADMIN_USER }) });
      }
      if (path === "/users" && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [EXISTING_USER], total: 1, page: 1, pageSize: 25 }),
        });
      }
      if (path === "/roles") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ roles: [{ id: "r1", code: "RESPONDER", name: "Responder", description: null }] }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
}

function renderUsersPage(): void {
  render(
    <AuthProvider>
      <UsersPage />
    </AuthProvider>,
  );
}

describe("UsersPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists existing users", async () => {
    mockRoutes();
    renderUsersPage();

    await waitFor(() => {
      expect(screen.getByText("Existing User")).toBeInTheDocument();
    });
    expect(screen.getByText("existing@example.invalid")).toBeInTheDocument();
  });

  it("opens the create-user modal and submits a new user", async () => {
    let created = false;
    mockRoutes({
      "POST /users": () => {
        created = true;
        return { user: { ...EXISTING_USER, id: "new-id", email: "new@example.invalid", displayName: "New Person" } };
      },
    });
    renderUsersPage();

    const newUserButton = await screen.findByRole("button", { name: "New user" });
    fireEvent.click(newUserButton);

    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "new@example.invalid" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "New Person" } });
    fireEvent.change(screen.getByLabelText("Initial password"), { target: { value: "Strong-Pass-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() => {
      expect(created).toBe(true);
    });
  });
});
