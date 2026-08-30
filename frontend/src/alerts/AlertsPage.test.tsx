import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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
  permissions: [
    "alerts.read",
    "alerts.create",
    "alerts.update",
    "alerts.ready",
    "alerts.cancel",
    "alerts.recipients.read",
    "alerts.dispatch",
  ],
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

const EMPTY_DELIVERY_SUMMARY = {
  total: 0,
  submissionFailed: 0,
  deliveryPending: 0,
  delivered: 0,
  undelivered: 0,
  bounced: 0,
  failed: 0,
  overallStatus: "pending" as const,
  deliveryCompletedAt: null,
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
  submittedCount: 0,
  submissionFailedCount: 0,
  pendingDispatchCount: 0,
  deliverySummary: EMPTY_DELIVERY_SUMMARY,
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

  it("dispatches a READY alert with an explicit confirmation showing mock-provider labeling", async () => {
    let dispatched = false;
    mockRoutes({
      [`GET /alerts/${DRAFT_ALERT.id}`]: () => ({
        alert: { ...DRAFT_ALERT_DETAIL, status: "ready", eligibleRecipientCount: 2, excludedCount: 0 },
      }),
      "GET /alerts/provider-status": () => ({
        sms: { provider: "mock", configured: true },
        email: { provider: "mock", configured: true },
      }),
      [`POST /alerts/${DRAFT_ALERT.id}/dispatch`]: () => {
        dispatched = true;
        return { alertId: DRAFT_ALERT.id, status: "submitted", totalRecipients: 2, submitted: 2, submissionFailed: 0, pending: 0 };
      },
    });
    renderAlertsPage();

    fireEvent.click(await screen.findByText("Cybersecurity Test Alert"));
    fireEvent.click(await screen.findByRole("button", { name: "Dispatch Alert" }));

    await screen.findByText(/Mock \/ Development/);
    expect(screen.getByText(/You are about to submit this SMS alert to 2 recipients/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm Dispatch" }));

    await waitFor(() => {
      expect(dispatched).toBe(true);
    });
  });

  it("shows the submission summary after dispatch, never claiming delivery is complete before evidence exists", async () => {
    mockRoutes({
      [`GET /alerts/${DRAFT_ALERT.id}`]: () => ({
        alert: {
          ...DRAFT_ALERT_DETAIL,
          status: "submitted",
          eligibleRecipientCount: 2,
          submittedCount: 2,
          submissionFailedCount: 0,
          pendingDispatchCount: 0,
          deliverySummary: { ...EMPTY_DELIVERY_SUMMARY, total: 2, deliveryPending: 2, overallStatus: "in_progress" },
        },
      }),
    });
    renderAlertsPage();

    fireEvent.click(await screen.findByText("Cybersecurity Test Alert"));

    await screen.findByText(/2 submitted/);
    // The Delivery Tracking section legitimately shows "0 delivered" (a real count, not a claim) —
    // what must never appear is a false completion claim before any delivery evidence exists.
    expect(screen.getByText("0 delivered, 2 pending")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.queryByText("Complete")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dispatch Alert" })).not.toBeInTheDocument();
  });

  it("shows a Complete delivery badge only once every submitted recipient has reached delivered", async () => {
    mockRoutes({
      [`GET /alerts/${DRAFT_ALERT.id}`]: () => ({
        alert: {
          ...DRAFT_ALERT_DETAIL,
          status: "submitted",
          eligibleRecipientCount: 2,
          submittedCount: 2,
          submissionFailedCount: 0,
          pendingDispatchCount: 0,
          deliverySummary: {
            ...EMPTY_DELIVERY_SUMMARY,
            total: 2,
            delivered: 2,
            overallStatus: "complete",
            deliveryCompletedAt: "2026-01-01T00:05:00.000Z",
          },
        },
      }),
    });
    renderAlertsPage();

    fireEvent.click(await screen.findByText("Cybersecurity Test Alert"));

    await screen.findByText("Complete");
    expect(screen.getByText("2 delivered")).toBeInTheDocument();
  });

  const SUBMITTED_RECIPIENT = {
    id: "77777777-7777-7777-7777-777777777777",
    contactId: "66666666-6666-6666-6666-666666666666",
    displayName: "Alex Responder",
    destination: "+15550001111",
    channel: "sms",
    renderedSubject: null,
    renderedBody: "Hi Alex",
    status: "submitted",
    provider: "mock",
    providerMessageId: "mock-mock-1",
    attemptCount: 1,
    lastFailureClass: null,
    lastErrorCode: null,
    lastErrorSummary: null,
    submittedAt: "2026-01-01T00:00:00.000Z",
    failedAt: null,
    deliveryStatus: "pending",
    deliveryUpdatedAt: "2026-01-01T00:00:00.000Z",
    deliveredAt: null,
    providerDeliveryCode: null,
    deliveryErrorSummary: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("shows a Recipients tab with delivery status for a user with alerts.recipients.read", async () => {
    mockRoutes({
      [`GET /alerts/${DRAFT_ALERT.id}`]: () => ({
        alert: {
          ...DRAFT_ALERT_DETAIL,
          status: "submitted",
          submittedCount: 1,
          deliverySummary: { ...EMPTY_DELIVERY_SUMMARY, total: 1, deliveryPending: 1, overallStatus: "in_progress" },
        },
      }),
      [`GET /alerts/${DRAFT_ALERT.id}/recipients`]: () => ({ items: [SUBMITTED_RECIPIENT], total: 1, page: 1, pageSize: 100 }),
    });
    renderAlertsPage();

    fireEvent.click(await screen.findByText("Cybersecurity Test Alert"));
    fireEvent.click(await screen.findByRole("button", { name: "Recipients" }));

    await screen.findByText("Alex Responder");
    // "submitted" also appears in the Alert-level status badge — scope the check to the
    // recipient table row so this asserts the recipient's own submission/delivery status cells.
    const row = screen.getByText("Alex Responder").closest("tr")!;
    expect(within(row).getByText("submitted")).toBeInTheDocument();
    expect(within(row).getByText("pending")).toBeInTheDocument();
  });

  it("hides the Recipients tab for a user without alerts.recipients.read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/auth/me") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ user: { ...ADMIN_USER, roles: ["COMMUNICATION_MANAGER"], permissions: ["alerts.read", "alerts.dispatch"] } }),
          });
        }
        if (path === "/alerts" && method === "GET") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [DRAFT_ALERT], total: 1, page: 1, pageSize: 25 }) });
        }
        if (path === `/alerts/${DRAFT_ALERT.id}` && method === "GET") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ alert: { ...DRAFT_ALERT_DETAIL, status: "submitted", submittedCount: 1 } }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );
    renderAlertsPage();

    fireEvent.click(await screen.findByText("Cybersecurity Test Alert"));
    await screen.findByText(/1 submitted/);
    expect(screen.queryByRole("button", { name: "Recipients" })).not.toBeInTheDocument();
  });

  it("simulates a mock delivery outcome from the Recipients tab, clearly labeled as development-only", async () => {
    let simulated = false;
    mockRoutes({
      [`GET /alerts/${DRAFT_ALERT.id}`]: () => ({
        alert: { ...DRAFT_ALERT_DETAIL, status: "submitted", submittedCount: 1 },
      }),
      [`GET /alerts/${DRAFT_ALERT.id}/recipients`]: () => ({ items: [SUBMITTED_RECIPIENT], total: 1, page: 1, pageSize: 100 }),
      [`POST /alerts/${DRAFT_ALERT.id}/recipients/${SUBMITTED_RECIPIENT.id}/mock-delivery`]: () => {
        simulated = true;
        return { recipient: { ...SUBMITTED_RECIPIENT, deliveryStatus: "delivered" } };
      },
    });
    renderAlertsPage();

    fireEvent.click(await screen.findByText("Cybersecurity Test Alert"));
    fireEvent.click(await screen.findByRole("button", { name: "Recipients" }));

    await screen.findByText(/Development\/Mock only/);
    fireEvent.click(await screen.findByRole("button", { name: "delivered" }));

    await waitFor(() => {
      expect(simulated).toBe(true);
    });
  });

  it("does not show the Dispatch control for a user without alerts.dispatch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/auth/me") {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                user: { ...ADMIN_USER, roles: ["RESPONDER"], permissions: ["alerts.read"] },
              }),
          });
        }
        if (path === "/alerts" && method === "GET") {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [DRAFT_ALERT], total: 1, page: 1, pageSize: 25 }) });
        }
        if (path === `/alerts/${DRAFT_ALERT.id}` && method === "GET") {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ alert: { ...DRAFT_ALERT_DETAIL, status: "ready", eligibleRecipientCount: 2 } }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }),
    );
    renderAlertsPage();

    fireEvent.click(await screen.findByText("Cybersecurity Test Alert"));
    await waitFor(() => {
      expect(screen.getByText(/This alert is READY/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Dispatch Alert" })).not.toBeInTheDocument();
  });
});
