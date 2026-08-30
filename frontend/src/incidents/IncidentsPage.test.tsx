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
    "contacts.read",
  ],
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

function renderIncidentsPage(): void {
  render(
    <AuthProvider>
      <IncidentsPage />
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
});
