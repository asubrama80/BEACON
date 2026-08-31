import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import UserDetailModal from "./UserDetailModal";

const TARGET_ID = "66666666-6666-6666-6666-666666666666";

const TARGET_USER = {
  id: TARGET_ID,
  email: "target@example.invalid",
  displayName: "Target User",
  status: "active",
  isBreakGlass: false,
  roles: [{ id: "r1", code: "RESPONDER", name: "Responder" }],
  effectivePermissions: ["incidents.read"],
  mfaEnabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function adminUser(permissions: string[]) {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    email: "admin@example.invalid",
    displayName: "Admin User",
    status: "active",
    isBreakGlass: false,
    mfaEnabled: false,
    roles: ["ADMIN"],
    permissions,
  };
}

function mockRoutes(currentUserPermissions: string[], overrides: Record<string, () => unknown> = {}): void {
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
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: adminUser(currentUserPermissions) }) });
      }
      if (path === `/users/${TARGET_ID}` && method === "GET") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: TARGET_USER }) });
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

function renderModal(currentUserPermissions: string[], overrides: Record<string, () => unknown> = {}) {
  mockRoutes(currentUserPermissions, overrides);
  render(
    <AuthProvider>
      <UserDetailModal userId={TARGET_ID} onClose={() => {}} onChanged={() => {}} />
    </AuthProvider>,
  );
}

describe("UserDetailModal — Module 22 admin-privileged security actions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides Security actions without admin.manage", async () => {
    renderModal(["users.read"]);
    await screen.findByText("Target User");
    expect(screen.queryByText("Security actions")).not.toBeInTheDocument();
  });

  it("shows Security actions with admin.manage, including current MFA status", async () => {
    renderModal(["users.read", "admin.manage"]);
    await screen.findByText("Security actions");
    expect(screen.getByText("MFA: Enabled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke active sessions" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset MFA" })).toBeInTheDocument();
  });

  it("does not offer Reset MFA when the target has no active MFA credential", async () => {
    renderModal(["users.read", "admin.manage"], {
      [`GET /users/${TARGET_ID}`]: () => ({ user: { ...TARGET_USER, mfaEnabled: false } }),
    });
    await screen.findByText("Security actions");
    expect(screen.getByText("MFA: Not enabled")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset MFA" })).not.toBeInTheDocument();
  });

  it("revokes sessions only after confirmation", async () => {
    let revoked = false;
    renderModal(["users.read", "admin.manage"], {
      [`POST /admin/users/${TARGET_ID}/sessions/revoke`]: () => {
        revoked = true;
        return { success: true };
      },
    });
    await screen.findByText("Security actions");

    fireEvent.click(screen.getByRole("button", { name: "Revoke active sessions" }));
    expect(revoked).toBe(false);

    fireEvent.click(await screen.findByRole("button", { name: "Confirm revoke sessions" }));
    await waitFor(() => expect(revoked).toBe(true));
  });

  it("resets MFA only after confirmation and refreshes the MFA status", async () => {
    let reset = false;
    renderModal(["users.read", "admin.manage"], {
      [`POST /admin/users/${TARGET_ID}/mfa/reset`]: () => {
        reset = true;
        return { success: true };
      },
      [`GET /users/${TARGET_ID}`]: () => ({ user: { ...TARGET_USER, mfaEnabled: !reset } }),
    });
    await screen.findByText("Security actions");

    fireEvent.click(screen.getByRole("button", { name: "Reset MFA" }));
    expect(reset).toBe(false);

    fireEvent.click(await screen.findByRole("button", { name: "Confirm reset MFA" }));
    await waitFor(() => expect(reset).toBe(true));
  });
});
