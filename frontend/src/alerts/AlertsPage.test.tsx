import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import AlertsPage from "./AlertsPage";

const ADMIN_USER = {
  id: "88888888-8888-8888-8888-888888888888",
  email: "admin@example.invalid",
  displayName: "Admin User",
  status: "active",
  isBreakGlass: false,
  mfaEnabled: false,
  roles: ["ADMIN"],
  permissions: ["alerts.read", "alerts.create", "alerts.update", "alerts.ready", "alerts.cancel", "alerts.recipients.read"],
};

const DRAFT_ALERT = {
  id: "99999999-9999-9999-9999-999999999999",
  alertNumber: "ALT-2026-000001",
  title: "Cybersecurity Test Alert",
  incident: null,
  channel: "sms",
  status: "draft",
  contentSource: "adhoc",
  eligibleRecipientCount: null,
  excludedCount: null,
  createdByDisplayName: "Admin User",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  readyAt: null,
  cancelledAt: null,
};

const DRAFT_ALERT_DETAIL = {
  ...DRAFT_ALERT,
  template: null,
  templateNameSnapshot: null,
  subject: null,
  body: "Hi {{firstName}}",
  exclusionSummary: null,
  sourceContactCount: 0,
  sourceGroupCount: 0,
  sourceContacts: [],
  sourceGroups: [],
};

function mockRoutes(overrides: Record<string, () => unknown> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = (init?.method ?? "GET").toUpperCase();
      const key = `${method} ${path}`;

      if (overrides[key]) {
        const result = overrides[key]!();
        return Promise.resolve({ ok: true, json: () => Promise.resolve(result) });
      }
      if (path === "/auth/me") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: ADMIN_USER }) });
      }
      if (path === "/alerts" && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [DRAFT_ALERT], total: 1, page: 1, pageSize: 25 }),
        });
      }
      if (path === `/alerts/${DRAFT_ALERT.id}` && method === "GET") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ alert: DRAFT_ALERT_DETAIL }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
}

function renderAlertsPage(): void {
  render(
    <AuthProvider>
      <AlertsPage />
    </AuthProvider>,
  );
}

describe("AlertsPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists existing alerts with number, channel, and status badge", async () => {
    mockRoutes();
    renderAlertsPage();

    await waitFor(() => {
      expect(screen.getByText("Cybersecurity Test Alert")).toBeInTheDocument();
    });
    expect(screen.getByText("ALT-2026-000001")).toBeInTheDocument();
    expect(screen.getAllByText("SMS").length).toBeGreaterThan(0);
    expect(screen.getByText("draft")).toBeInTheDocument();
  });

  it("opens the create-alert modal and submits a new alert", async () => {
    let created = false;
    mockRoutes({
      "POST /alerts": () => {
        created = true;
        return { alert: { ...DRAFT_ALERT_DETAIL, id: "new-id", title: "Network Outage" } };
      },
    });
    renderAlertsPage();

    fireEvent.click(await screen.findByRole("button", { name: "Create Alert" }));
    fireEvent.change(await screen.findByLabelText("Alert title"), { target: { value: "Network Outage" } });
    fireEvent.change(screen.getByLabelText("Message body"), { target: { value: "Hi {{firstName}}" } });
    const submitButtons = screen.getAllByRole("button", { name: "Create Alert" });
    fireEvent.click(submitButtons[submitButtons.length - 1]!);

    await waitFor(() => {
      expect(created).toBe(true);
    });
  });

  it("opens the detail modal, previews audience, and marks the alert ready", async () => {
    let readied = false;
    mockRoutes({
      [`POST /alerts/${DRAFT_ALERT.id}/preview`]: () => ({
        channel: "sms",
        uniqueRecipientCount: 1,
        eligibleCount: 1,
        excludedCount: 0,
        exclusionSummary: {},
        duplicatesCollapsedCount: 0,
        invalidGroupIds: [],
        zeroRecipientWarning: false,
        templateActive: null,
        sampleRenderedBody: "Hi Alex",
      }),
      [`POST /alerts/${DRAFT_ALERT.id}/ready`]: () => {
        readied = true;
        return { alert: { ...DRAFT_ALERT_DETAIL, status: "ready", eligibleRecipientCount: 1, excludedCount: 0 } };
      },
    });
    renderAlertsPage();

    fireEvent.click(await screen.findByText("Cybersecurity Test Alert"));
    fireEvent.click(await screen.findByRole("button", { name: "Preview audience & content" }));
    await screen.findByText("1 eligible recipient");

    fireEvent.click(screen.getByRole("button", { name: "Mark Ready" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm Ready" }));

    await waitFor(() => {
      expect(readied).toBe(true);
    });
  });

  it("shows a read-only READY banner once ready", async () => {
    mockRoutes({
      [`GET /alerts/${DRAFT_ALERT.id}`]: () => ({
        alert: { ...DRAFT_ALERT_DETAIL, status: "ready", eligibleRecipientCount: 3, excludedCount: 1 },
      }),
    });
    renderAlertsPage();

    fireEvent.click(await screen.findByText("Cybersecurity Test Alert"));
    await waitFor(() => {
      expect(screen.getByText(/This alert is READY/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Save details" })).not.toBeInTheDocument();
  });
});
