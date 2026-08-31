import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const EMPTY_DASHBOARD = {
  incidents: { total: 0, open: 0, active: 0, resolved: 0, closed: 0, recent: [] },
  alerts: { total: 0, draft: 0, ready: 0, dispatching: 0, submitted: 0, partiallySubmitted: 0, submissionFailed: 0, cancelled: 0, delivery: { total: 0, submissionFailed: 0, deliveryPending: 0, delivered: 0, undelivered: 0, bounced: 0, failed: 0 }, recent: [] },
  contacts: { active: 0 },
  groups: { active: 0 },
  attention: { readyAlertsNotDispatched: 0, deliveryFailures: 0 },
};

/** Every test lands on the Dashboard (the default view) at least momentarily, so `/dashboard`
 * must always resolve to a valid empty shape regardless of which other endpoint a test cares
 * about — otherwise DashboardPage's own fetch throws/crashes the render before the test's
 * assertions ever run. */
function mockAuthMe(authMeResponse: { ok: boolean; json: () => Promise<unknown> }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/dashboard") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(EMPTY_DASHBOARD) });
      }
      return Promise.resolve(authMeResponse);
    }),
  );
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
      expect(screen.getByText("Active Contacts")).toBeInTheDocument();
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
      expect(screen.getByText("Active Contacts")).toBeInTheDocument();
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
        if (path === "/dashboard") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(EMPTY_DASHBOARD) });
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

  it("shows Contacts navigation for a user with contacts.read and can reach the page", async () => {
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
                  id: "44444444-4444-4444-4444-444444444444",
                  email: "commmanager@example.invalid",
                  displayName: "Comm Manager",
                  status: "active",
                  isBreakGlass: false,
                  mfaEnabled: false,
                  roles: ["COMMUNICATION_MANAGER"],
                  permissions: ["contacts.read", "contacts.create"],
                },
              }),
          });
        }
        if (path === "/contacts") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 25 }),
          });
        }
        if (path === "/dashboard") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(EMPTY_DASHBOARD) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    render(<App />);

    expect(screen.queryByRole("button", { name: "Users" })).not.toBeInTheDocument();
    const contactsNavButton = await screen.findByRole("button", { name: "Contacts" });
    contactsNavButton.click();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: "Contacts" })).toBeInTheDocument();
    });
  });

  it("shows Groups navigation for a user with groups.read and can reach the page", async () => {
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
                  id: "55555555-5555-5555-5555-555555555555",
                  email: "auditor@example.invalid",
                  displayName: "Auditor User",
                  status: "active",
                  isBreakGlass: false,
                  mfaEnabled: false,
                  roles: ["AUDITOR"],
                  permissions: ["groups.read"],
                },
              }),
          });
        }
        if (path === "/groups") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 25 }),
          });
        }
        if (path === "/dashboard") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(EMPTY_DASHBOARD) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    render(<App />);

    const groupsNavButton = await screen.findByRole("button", { name: "Groups" });
    groupsNavButton.click();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: "Groups" })).toBeInTheDocument();
    });
  });

  it("shows Templates navigation for a user with templates.read and can reach the page", async () => {
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
                  id: "66666666-6666-6666-6666-666666666666",
                  email: "commmanager@example.invalid",
                  displayName: "Comm Manager",
                  status: "active",
                  isBreakGlass: false,
                  mfaEnabled: false,
                  roles: ["COMMUNICATION_MANAGER"],
                  permissions: ["templates.read", "templates.create"],
                },
              }),
          });
        }
        if (path === "/templates") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 25 }),
          });
        }
        if (path === "/dashboard") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(EMPTY_DASHBOARD) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    render(<App />);

    const templatesNavButton = await screen.findByRole("button", { name: "Templates" });
    templatesNavButton.click();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: "Templates" })).toBeInTheDocument();
    });
  });

  it("shows Incidents navigation for a user with incidents.read and can reach the page", async () => {
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
                  id: "77777777-7777-7777-7777-777777777777",
                  email: "responder@example.invalid",
                  displayName: "Responder User",
                  status: "active",
                  isBreakGlass: false,
                  mfaEnabled: false,
                  roles: ["RESPONDER"],
                  permissions: ["incidents.read", "incidents.timeline.read"],
                },
              }),
          });
        }
        if (path === "/incidents") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 25 }),
          });
        }
        if (path === "/dashboard") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(EMPTY_DASHBOARD) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    render(<App />);

    const incidentsNavButton = await screen.findByRole("button", { name: "Incidents" });
    incidentsNavButton.click();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: "Incidents" })).toBeInTheDocument();
    });
  });

  it("does not show Incidents navigation for a user without incidents.read", async () => {
    mockAuthMe({
      ok: true,
      json: () =>
        Promise.resolve({
          user: {
            id: "88888888-9999-9999-9999-999999999999",
            email: "noaccess@example.invalid",
            displayName: "No Access User",
            status: "active",
            isBreakGlass: false,
            mfaEnabled: false,
            roles: [],
            permissions: [],
          },
        }),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Active Contacts")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Incidents" })).not.toBeInTheDocument();
  });

  it("shows Alerts navigation for a user with alerts.read and can reach the page", async () => {
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
                  id: "99999999-1111-1111-1111-111111111111",
                  email: "commsmgr@example.invalid",
                  displayName: "Comms Manager",
                  status: "active",
                  isBreakGlass: false,
                  mfaEnabled: false,
                  roles: ["COMMUNICATION_MANAGER"],
                  permissions: ["alerts.read", "alerts.create"],
                },
              }),
          });
        }
        if (path === "/alerts") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 25 }),
          });
        }
        if (path === "/dashboard") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(EMPTY_DASHBOARD) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    render(<App />);

    const alertsNavButton = await screen.findByRole("button", { name: "Alerts" });
    alertsNavButton.click();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: "Alerts" })).toBeInTheDocument();
    });
  });

  it("does not show Alerts navigation for a user without alerts.read", async () => {
    mockAuthMe({
      ok: true,
      json: () =>
        Promise.resolve({
          user: {
            id: "99999999-2222-2222-2222-222222222222",
            email: "noaccess2@example.invalid",
            displayName: "No Access User Two",
            status: "active",
            isBreakGlass: false,
            mfaEnabled: false,
            roles: [],
            permissions: [],
          },
        }),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Active Contacts")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Alerts" })).not.toBeInTheDocument();
  });

  it("Module 24 — shows Administration navigation for a user with admin.read and can reach the page", async () => {
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
                  id: "aaaaaaaa-1111-1111-1111-111111111111",
                  email: "admin-nav@example.invalid",
                  displayName: "Admin Nav User",
                  status: "active",
                  isBreakGlass: false,
                  mfaEnabled: false,
                  roles: ["ADMIN"],
                  permissions: ["admin.read"],
                },
              }),
          });
        }
        if (path === "/admin/status") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                application: { name: "beacon-backend", version: "0.0.0", environment: "test" },
                database: { connected: true },
                security: { mfaAvailable: true, sessionTtlHours: 12, passwordMinLength: 12, loginMaxFailures: 5, breakGlass: { present: false, status: null } },
                providers: { sms: "mock", email: "mock" },
                collaboration: { status: "foundation_only" },
              }),
          });
        }
        if (path === "/admin/roles") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) });
        }
        if (path === "/dashboard") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(EMPTY_DASHBOARD) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    render(<App />);

    const adminNavButton = await screen.findByRole("button", { name: "Administration" });
    adminNavButton.click();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: "Administration" })).toBeInTheDocument();
    });
  });

  it("Module 24 — does not show Administration navigation for a user without admin.read", async () => {
    mockAuthMe({
      ok: true,
      json: () =>
        Promise.resolve({
          user: {
            id: "aaaaaaaa-2222-2222-2222-222222222222",
            email: "noaccess-admin@example.invalid",
            displayName: "No Admin Access User",
            status: "active",
            isBreakGlass: false,
            mfaEnabled: false,
            roles: [],
            permissions: [],
          },
        }),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Active Contacts")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Administration" })).not.toBeInTheDocument();
  });

  it("Module 24 — shows Audit navigation for a user with audit.read and can reach the page", async () => {
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
                  id: "bbbbbbbb-1111-1111-1111-111111111111",
                  email: "auditor-nav@example.invalid",
                  displayName: "Auditor Nav User",
                  status: "active",
                  isBreakGlass: false,
                  mfaEnabled: false,
                  roles: ["AUDITOR"],
                  permissions: ["audit.read"],
                },
              }),
          });
        }
        if (path === "/audit") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [], nextCursor: null }) });
        }
        if (path === "/dashboard") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(EMPTY_DASHBOARD) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    render(<App />);

    const auditNavButton = await screen.findByRole("button", { name: "Audit" });
    auditNavButton.click();

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 2, name: "Audit" })).toBeInTheDocument();
    });
  });

  it("Module 24 — does not show Audit navigation for a user without audit.read", async () => {
    mockAuthMe({
      ok: true,
      json: () =>
        Promise.resolve({
          user: {
            id: "bbbbbbbb-2222-2222-2222-222222222222",
            email: "noaccess-audit@example.invalid",
            displayName: "No Audit Access User",
            status: "active",
            isBreakGlass: false,
            mfaEnabled: false,
            roles: [],
            permissions: [],
          },
        }),
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Active Contacts")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Audit" })).not.toBeInTheDocument();
  });

  it("Module 24 — a Guest session cookie never grants access to the authenticated shell (401 falls back to login)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL) => {
        const path = new URL(String(input)).pathname;
        if (path === "/auth/me") {
          return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({ error: "not_authenticated" }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "BEACON" })).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });
});
