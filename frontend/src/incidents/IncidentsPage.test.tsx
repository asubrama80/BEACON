import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../auth/AuthContext";
import IncidentsPage from "./IncidentsPage";

const ADMIN_USER = {
  id: "88888888-8888-8888-8888-888888888888",
  email: "admin@example.invalid",
  displayName: "Admin User",
  status: "active",
  isBreakGlass: false,
  mfaEnabled: false,
  roles: ["ADMIN"],
  permissions: [
    "incidents.read",
    "incidents.create",
    "incidents.update",
    "incidents.lifecycle.manage",
    "incidents.commander.assign",
    "incidents.participants.manage",
    "incidents.timeline.read",
    "incidents.command_center.read",
    "incidents.chat.read",
    "incidents.chat.send",
    "alerts.create",
    "contacts.read",
  ],
};

const EMPTY_COMMAND_CENTER = {
  incident: null as unknown, // filled in per-test via OPEN_INCIDENT
  participantsSummary: { total: 0, registeredUsers: 0, contacts: 0 },
  alertsSummary: {
    total: 0,
    draft: 0,
    ready: 0,
    dispatching: 0,
    submitted: 0,
    partiallySubmitted: 0,
    submissionFailed: 0,
    cancelled: 0,
    delivery: { total: 0, submissionFailed: 0, deliveryPending: 0, delivered: 0, undelivered: 0, bounced: 0, failed: 0 },
  },
  recentAlerts: [] as unknown[],
  recentTimeline: [] as unknown[],
};

const OPEN_INCIDENT = {
  id: "99999999-9999-9999-9999-999999999999",
  incidentNumber: "INC-2026-000001",
  title: "Potential Cybersecurity Incident",
  description: "Investigating unusual network activity.",
  severity: "high",
  status: "open",
  commander: null,
  participantCount: 0,
  registeredUserCount: 0,
  contactParticipantCount: 0,
  activatedAt: null,
  resolvedAt: null,
  closedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const CLOSED_INCIDENT = {
  ...OPEN_INCIDENT,
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  incidentNumber: "INC-2026-000002",
  status: "closed",
  closedAt: "2026-01-02T00:00:00.000Z",
};

const SEARCHABLE_USER = {
  id: "bbbbbbbb-2222-2222-2222-222222222222",
  email: "responder@example.invalid",
  displayName: "Findable Responder",
  status: "active",
  isBreakGlass: false,
  roles: [],
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
        const result = overrides[key]!();
        return Promise.resolve({ ok: true, json: () => Promise.resolve(result) });
      }
      if (path === "/auth/me") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ user: ADMIN_USER }) });
      }
      if (path === "/incidents" && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [OPEN_INCIDENT], total: 1, page: 1, pageSize: 25 }),
        });
      }
      if (path === `/incidents/${OPEN_INCIDENT.id}` && method === "GET") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ incident: OPEN_INCIDENT }) });
      }
      if (path === `/incidents/${OPEN_INCIDENT.id}/participants` && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [], total: 0, page: 1, pageSize: 25 }),
        });
      }
      if (path === `/incidents/${OPEN_INCIDENT.id}/timeline` && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              items: [
                {
                  id: "cccccccc-3333-3333-3333-333333333333",
                  eventType: "INCIDENT_CREATED",
                  actorUserId: ADMIN_USER.id,
                  actorDisplayName: ADMIN_USER.displayName,
                  metadata: {},
                  occurredAt: "2026-01-01T00:00:00.000Z",
                },
              ],
              total: 1,
              page: 1,
              pageSize: 25,
            }),
        });
      }
      if (path === "/users" && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ items: [SEARCHABLE_USER], total: 1, page: 1, pageSize: 25 }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
}

function renderIncidentsPage(onNavigateToAlerts?: (request: { alertId?: string; createIncidentId?: string }) => void): void {
  render(
    <AuthProvider>
      <IncidentsPage onNavigateToAlerts={onNavigateToAlerts} />
    </AuthProvider>,
  );
}

describe("IncidentsPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists existing incidents with severity/status badges", async () => {
    mockRoutes();
    renderIncidentsPage();

    await waitFor(() => {
      expect(screen.getByText("Potential Cybersecurity Incident")).toBeInTheDocument();
    });
    expect(screen.getByText("INC-2026-000001")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("opens the create-incident modal and submits a new incident", async () => {
    let created = false;
    mockRoutes({
      "POST /incidents": () => {
        created = true;
        return { incident: { ...OPEN_INCIDENT, id: "new-id", title: "Network Outage" } };
      },
    });
    renderIncidentsPage();

    fireEvent.click(await screen.findByRole("button", { name: "Create Incident" }));
    fireEvent.change(await screen.findByLabelText("Incident title"), { target: { value: "Network Outage" } });
    const submitButtons = screen.getAllByRole("button", { name: "Create Incident" });
    fireEvent.click(submitButtons[submitButtons.length - 1]!);

    await waitFor(() => {
      expect(created).toBe(true);
    });
  });

  it("opens the detail modal and activates an open incident", async () => {
    let activated = false;
    mockRoutes({
      [`POST /incidents/${OPEN_INCIDENT.id}/activate`]: () => {
        activated = true;
        return { incident: { ...OPEN_INCIDENT, status: "active", activatedAt: "2026-01-01T01:00:00.000Z" } };
      },
    });
    renderIncidentsPage();

    fireEvent.click(await screen.findByText("Potential Cybersecurity Incident"));
    fireEvent.click(await screen.findByRole("button", { name: "Activate" }));

    await waitFor(() => {
      expect(activated).toBe(true);
    });
  });

  it("adds a responder to the participants roster", async () => {
    let addedUserId: string | null = null;
    mockRoutes({
      [`POST /incidents/${OPEN_INCIDENT.id}/participants/users`]: () => {
        addedUserId = SEARCHABLE_USER.id;
        return { added: true };
      },
    });
    renderIncidentsPage();

    fireEvent.click(await screen.findByText("Potential Cybersecurity Incident"));
    fireEvent.click(await screen.findByRole("button", { name: "Participants" }));

    fireEvent.change(await screen.findByPlaceholderText("Search active BEACON users"), {
      target: { value: "Findable" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Search" })[0]!);

    await screen.findByText("Findable Responder");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(addedUserId).toBe(SEARCHABLE_USER.id);
    });
  });

  it("shows timeline events", async () => {
    mockRoutes();
    renderIncidentsPage();

    fireEvent.click(await screen.findByText("Potential Cybersecurity Incident"));
    fireEvent.click(await screen.findByRole("button", { name: "Timeline" }));

    await waitFor(() => {
      expect(screen.getByText("INCIDENT CREATED")).toBeInTheDocument();
    });
  });

  it("hides edit and lifecycle controls for a closed incident", async () => {
    mockRoutes({
      "GET /incidents": () => ({ items: [CLOSED_INCIDENT], total: 1, page: 1, pageSize: 25 }),
      [`GET /incidents/${CLOSED_INCIDENT.id}`]: () => ({ incident: CLOSED_INCIDENT }),
    });
    renderIncidentsPage();

    fireEvent.click(await screen.findByText("Potential Cybersecurity Incident"));

    await waitFor(() => {
      expect(screen.getByText(/This incident is closed/)).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "Save details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate" })).not.toBeInTheDocument();
  });

  describe("Command Center tab", () => {
    it("shows the aggregate communication summary and recent alerts", async () => {
      mockRoutes({
        [`GET /incidents/${OPEN_INCIDENT.id}/command-center`]: () => ({
          ...EMPTY_COMMAND_CENTER,
          incident: OPEN_INCIDENT,
          alertsSummary: {
            ...EMPTY_COMMAND_CENTER.alertsSummary,
            total: 2,
            submitted: 1,
            draft: 1,
            delivery: { total: 1, submissionFailed: 0, deliveryPending: 0, delivered: 1, undelivered: 0, bounced: 0, failed: 0 },
          },
          recentAlerts: [
            {
              id: "dddddddd-4444-4444-4444-444444444444",
              alertNumber: "ALT-2026-000001",
              title: "Test Alert",
              channel: "sms",
              status: "submitted",
              createdByDisplayName: "Admin User",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deliverySummary: {
                total: 1,
                submissionFailed: 0,
                deliveryPending: 0,
                delivered: 1,
                undelivered: 0,
                bounced: 0,
                failed: 0,
                overallStatus: "complete",
                deliveryCompletedAt: "2026-01-01T00:05:00.000Z",
              },
            },
          ],
        }),
      });
      renderIncidentsPage();

      fireEvent.click(await screen.findByText("Potential Cybersecurity Incident"));
      fireEvent.click(await screen.findByRole("button", { name: "Command Center" }));

      await screen.findByText(/2 alerts/);
      expect(screen.getByText(/1 draft/)).toBeInTheDocument();
      expect(screen.getByText(/1 submitted/)).toBeInTheDocument();
      expect(screen.getByText("ALT-2026-000001")).toBeInTheDocument();
    });

    it("navigates to the Alerts page when View is clicked on a recent alert", async () => {
      const navigations: Array<{ alertId?: string; createIncidentId?: string }> = [];
      mockRoutes({
        [`GET /incidents/${OPEN_INCIDENT.id}/command-center`]: () => ({
          ...EMPTY_COMMAND_CENTER,
          incident: OPEN_INCIDENT,
          recentAlerts: [
            {
              id: "dddddddd-4444-4444-4444-444444444444",
              alertNumber: "ALT-2026-000001",
              title: "Test Alert",
              channel: "sms",
              status: "submitted",
              createdByDisplayName: "Admin User",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deliverySummary: {
                total: 1,
                submissionFailed: 0,
                deliveryPending: 1,
                delivered: 0,
                undelivered: 0,
                bounced: 0,
                failed: 0,
                overallStatus: "in_progress",
                deliveryCompletedAt: null,
              },
            },
          ],
        }),
      });
      renderIncidentsPage((request) => navigations.push(request));

      fireEvent.click(await screen.findByText("Potential Cybersecurity Incident"));
      fireEvent.click(await screen.findByRole("button", { name: "Command Center" }));
      fireEvent.click(await screen.findByRole("button", { name: "View" }));

      expect(navigations).toEqual([{ alertId: "dddddddd-4444-4444-4444-444444444444" }]);
    });

    it("navigates to alert creation, pre-selecting this incident, from the quick-create shortcut", async () => {
      const navigations: Array<{ alertId?: string; createIncidentId?: string }> = [];
      mockRoutes({
        [`GET /incidents/${OPEN_INCIDENT.id}/command-center`]: () => ({ ...EMPTY_COMMAND_CENTER, incident: OPEN_INCIDENT }),
      });
      renderIncidentsPage((request) => navigations.push(request));

      fireEvent.click(await screen.findByText("Potential Cybersecurity Incident"));
      fireEvent.click(await screen.findByRole("button", { name: "Command Center" }));
      fireEvent.click(await screen.findByRole("button", { name: "Create Alert for this Incident" }));

      expect(navigations).toEqual([{ createIncidentId: OPEN_INCIDENT.id }]);
    });

    it("hides the quick Create Alert shortcut for a closed incident (the backend would reject it)", async () => {
      mockRoutes({
        "GET /incidents": () => ({ items: [CLOSED_INCIDENT], total: 1, page: 1, pageSize: 25 }),
        [`GET /incidents/${CLOSED_INCIDENT.id}`]: () => ({ incident: CLOSED_INCIDENT }),
        [`GET /incidents/${CLOSED_INCIDENT.id}/command-center`]: () => ({ ...EMPTY_COMMAND_CENTER, incident: CLOSED_INCIDENT }),
      });
      renderIncidentsPage();

      fireEvent.click(await screen.findByText("Potential Cybersecurity Incident"));
      fireEvent.click(await screen.findByRole("button", { name: "Command Center" }));

      await screen.findByText(/0 alerts/);
      expect(screen.queryByRole("button", { name: "Create Alert for this Incident" })).not.toBeInTheDocument();
    });

    it("does not show the Command Center tab for a user without incidents.command_center.read", async () => {
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
                  user: { ...ADMIN_USER, permissions: ["incidents.read", "incidents.timeline.read"] },
                }),
            });
          }
          if (path === "/incidents" && method === "GET") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [OPEN_INCIDENT], total: 1, page: 1, pageSize: 25 }) });
          }
          if (path === `/incidents/${OPEN_INCIDENT.id}` && method === "GET") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ incident: OPEN_INCIDENT }) });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }),
      );
      renderIncidentsPage();

      fireEvent.click(await screen.findByText("Potential Cybersecurity Incident"));
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
      });
      expect(screen.queryByRole("button", { name: "Command Center" })).not.toBeInTheDocument();
    });
  });

  describe("Chat tab", () => {
    class MockWebSocket {
      static OPEN = 1;
      static instances: MockWebSocket[] = [];
      url: string;
      onopen: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      readyState = 0;
      constructor(url: string) {
        this.url = url;
        MockWebSocket.instances.push(this);
      }
      send(): void {
        /* not exercised at this level — see ChatPanel.test.tsx for send-path coverage */
      }
      close(): void {
        this.readyState = 3;
      }
    }

    it("shows the Chat tab and connects when the caller has incidents.chat.read", async () => {
      vi.stubGlobal("WebSocket", MockWebSocket);
      MockWebSocket.instances = [];
      mockRoutes({
        [`GET /incidents/${OPEN_INCIDENT.id}/chat/messages`]: () => ({ items: [], hasMore: false }),
      });
      renderIncidentsPage();

      fireEvent.click(await screen.findByText("Potential Cybersecurity Incident"));
      fireEvent.click(await screen.findByRole("button", { name: "Chat" }));

      await waitFor(() => {
        expect(MockWebSocket.instances.length).toBeGreaterThan(0);
      });
      vi.unstubAllGlobals();
    });

    it("hides the Chat tab for a user without incidents.chat.read", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL, init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          const method = (init?.method ?? "GET").toUpperCase();
          if (path === "/auth/me") {
            return Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ user: { ...ADMIN_USER, permissions: ["incidents.read", "incidents.timeline.read"] } }),
            });
          }
          if (path === "/incidents" && method === "GET") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [OPEN_INCIDENT], total: 1, page: 1, pageSize: 25 }) });
          }
          if (path === `/incidents/${OPEN_INCIDENT.id}` && method === "GET") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ incident: OPEN_INCIDENT }) });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        }),
      );
      renderIncidentsPage();

      fireEvent.click(await screen.findByText("Potential Cybersecurity Incident"));
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Overview" })).toBeInTheDocument();
      });
      expect(screen.queryByRole("button", { name: "Chat" })).not.toBeInTheDocument();
    });
  });
});
