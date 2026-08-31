import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdministrationPage from "./AdministrationPage";

const STATUS = {
  application: { name: "beacon-backend", version: "0.0.0", environment: "test" },
  database: { connected: true },
  security: {
    mfaAvailable: true,
    sessionTtlHours: 12,
    passwordMinLength: 12,
    loginMaxFailures: 5,
    breakGlass: { present: false, status: null },
  },
  providers: { sms: "mock", email: "mock" },
  collaboration: { status: "foundation_only" },
};

const ROLES = [
  { id: "role-1", code: "ADMIN", name: "Administrator", description: null, permissionCodes: ["admin.manage", "admin.read", "users.read"], userCount: 1 },
  { id: "role-2", code: "AUDITOR", name: "Auditor", description: null, permissionCodes: ["admin.read", "audit.read"], userCount: 2 },
];

function mockAdmin(statusBody: unknown = STATUS, rolesBody: unknown = ROLES, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const body = url.includes("/admin/roles") ? { items: rolesBody } : statusBody;
      return Promise.resolve({ ok, json: () => Promise.resolve(body) });
    }),
  );
}

describe("AdministrationPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows system, security, and provider status", async () => {
    mockAdmin();
    render(<AdministrationPage />);
    await screen.findByText("beacon-backend");
    expect(screen.getByText("0.0.0")).toBeInTheDocument();
    expect(screen.getByText("test")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("SMS Provider — mock")).toBeInTheDocument();
    expect(screen.getByText("Email Provider — mock")).toBeInTheDocument();
    expect(screen.getByText("12h")).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
  });

  it("never renders a credential or process.env-looking value", async () => {
    mockAdmin();
    const { container } = render(<AdministrationPage />);
    await screen.findByText("beacon-backend");
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/DATABASE_URL|passwordHash|secretKey|privateKey|apiKey|accessToken/i);
  });

  it("renders role-to-permission mapping with user counts", async () => {
    mockAdmin();
    render(<AdministrationPage />);
    await screen.findByText("Administrator");
    expect(screen.getByText("Auditor")).toBeInTheDocument();
    expect(screen.getAllByText("admin.read")).toHaveLength(2);
    expect(screen.getByText("admin.manage")).toBeInTheDocument();
  });

  it("navigates to Users and Audit via the Related links", async () => {
    const onNavigateToUsers = vi.fn();
    const onNavigateToAudit = vi.fn();
    mockAdmin();
    render(<AdministrationPage onNavigateToUsers={onNavigateToUsers} onNavigateToAudit={onNavigateToAudit} />);
    fireEvent.click(await screen.findByRole("button", { name: "Manage Users →" }));
    expect(onNavigateToUsers).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View Audit →" }));
    expect(onNavigateToAudit).toHaveBeenCalled();
  });

  it("shows an error banner when the request fails", async () => {
    mockAdmin({ error: "not_authorized", message: "You do not have permission to do that." }, [], false);
    render(<AdministrationPage />);
    await screen.findByText("You do not have permission to do that.");
  });
});
