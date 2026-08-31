import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "./DashboardPage";

const EMPTY_DASHBOARD = {
  incidents: { total: 0, open: 0, active: 0, resolved: 0, closed: 0, recent: [] },
  alerts: {
    total: 0,
    draft: 0,
    ready: 0,
    dispatching: 0,
    submitted: 0,
    partiallySubmitted: 0,
    submissionFailed: 0,
    cancelled: 0,
    delivery: { total: 0, submissionFailed: 0, deliveryPending: 0, delivered: 0, undelivered: 0, bounced: 0, failed: 0 },
    recent: [],
  },
  contacts: { active: 0 },
  groups: { active: 0 },
  attention: { readyAlertsNotDispatched: 0, deliveryFailures: 0 },
};

function mockDashboard(body: unknown, ok = true): void {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok, json: () => Promise.resolve(body) })));
}

describe("DashboardPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows metric cards and empty states with no data", async () => {
    mockDashboard(EMPTY_DASHBOARD);
    render(<DashboardPage />);
    await screen.findByText("Active Contacts");
    expect(screen.getByText("No incidents yet.")).toBeInTheDocument();
    expect(screen.getByText("No alerts have been sent yet.")).toBeInTheDocument();
    expect(screen.queryByText("Attention Required")).not.toBeInTheDocument();
  });

  it("shows an Attention Required section only when there is something to flag", async () => {
    mockDashboard({ ...EMPTY_DASHBOARD, attention: { readyAlertsNotDispatched: 2, deliveryFailures: 3 } });
    render(<DashboardPage />);
    await screen.findByText("Attention Required");
    expect(screen.getByText("2 alerts ready but not yet dispatched")).toBeInTheDocument();
    expect(screen.getByText("3 delivery failures across recent alerts")).toBeInTheDocument();
  });

  it("renders recent Incidents and Alerts", async () => {
    mockDashboard({
      ...EMPTY_DASHBOARD,
      incidents: {
        ...EMPTY_DASHBOARD.incidents,
        recent: [{ id: "inc-1", incidentNumber: "INC-2026-000001", title: "Server Outage", severity: "warning", status: "active", updatedAt: "2026-01-01T00:00:00.000Z" }],
      },
      alerts: {
        ...EMPTY_DASHBOARD.alerts,
        recent: [
          {
            id: "alert-1",
            alertNumber: "ALT-2026-000001",
            title: "Evacuation Notice",
            channel: "sms",
            status: "submitted",
            createdByDisplayName: "Admin User",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deliverySummary: { total: 10, submissionFailed: 0, deliveryPending: 2, delivered: 8, undelivered: 0, bounced: 0, failed: 0, overallStatus: "in_progress", deliveryCompletedAt: null },
          },
        ],
      },
    });
    render(<DashboardPage />);
    await screen.findByText("Server Outage");
    expect(screen.getByText("INC-2026-000001")).toBeInTheDocument();
    expect(screen.getByText("Evacuation Notice")).toBeInTheDocument();
  });

  it("navigates to Alerts when a recent alert row is clicked", async () => {
    const onNavigateToAlerts = vi.fn();
    mockDashboard({
      ...EMPTY_DASHBOARD,
      alerts: {
        ...EMPTY_DASHBOARD.alerts,
        recent: [
          {
            id: "alert-1",
            alertNumber: "ALT-2026-000001",
            title: "Evacuation Notice",
            channel: "sms",
            status: "submitted",
            createdByDisplayName: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deliverySummary: { total: 1, submissionFailed: 0, deliveryPending: 0, delivered: 1, undelivered: 0, bounced: 0, failed: 0, overallStatus: "complete", deliveryCompletedAt: "2026-01-01T00:01:00.000Z" },
          },
        ],
      },
    });
    render(<DashboardPage onNavigateToAlerts={onNavigateToAlerts} />);
    const row = (await screen.findByText("Evacuation Notice")).closest("tr")!;
    fireEvent.click(row);
    expect(onNavigateToAlerts).toHaveBeenCalledWith({ alertId: "alert-1" });
  });

  it("calls onNavigateToIncidents when 'View all incidents' is clicked", async () => {
    const onNavigateToIncidents = vi.fn();
    mockDashboard(EMPTY_DASHBOARD);
    render(<DashboardPage onNavigateToIncidents={onNavigateToIncidents} />);
    fireEvent.click(await screen.findByRole("button", { name: "View all incidents →" }));
    expect(onNavigateToIncidents).toHaveBeenCalled();
  });

  it("never treats delivery-pending recipients as delivered or as a failure", async () => {
    mockDashboard({
      ...EMPTY_DASHBOARD,
      alerts: { ...EMPTY_DASHBOARD.alerts, delivery: { total: 5, submissionFailed: 0, deliveryPending: 5, delivered: 0, undelivered: 0, bounced: 0, failed: 0 } },
      attention: { readyAlertsNotDispatched: 0, deliveryFailures: 0 },
    });
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText("0 delivered · 5 pending")).toBeInTheDocument());
    expect(screen.queryByText("Attention Required")).not.toBeInTheDocument();
  });

  it("shows an error banner when the request fails", async () => {
    mockDashboard({ error: "not_authorized", message: "You do not have permission to do that." }, false);
    render(<DashboardPage />);
    await screen.findByText("You do not have permission to do that.");
  });
});
