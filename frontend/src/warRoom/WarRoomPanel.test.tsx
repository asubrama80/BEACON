import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import WarRoomPanel from "./WarRoomPanel";

const INCIDENT_ID = "99999999-9999-9999-9999-999999999999";
const CURRENT_USER_ID = "11111111-1111-1111-1111-111111111111";

const NOT_STARTED = { status: "not_started", id: null, openedByDisplayName: null, openedAt: null, endedByDisplayName: null, endedAt: null, activeSessionCount: 0 };

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
      if (path === `/incidents/${INCIDENT_ID}/war-room/sessions`) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
}

function renderPanel(props: Partial<Parameters<typeof WarRoomPanel>[0]> = {}): void {
  render(
    <WarRoomPanel
      incidentId={INCIDENT_ID}
      incidentNumber="INC-2026-000001"
      incidentTitle="Test Incident"
      canRead={true}
      canManage={true}
      canJoin={true}
      isClosed={false}
      currentUserId={CURRENT_USER_ID}
      currentUserDisplayName="Admin User"
      {...props}
    />,
  );
}

describe("WarRoomPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows read-only messaging without incidents.war_room.read", () => {
    mockRoutes();
    renderPanel({ canRead: false });
    expect(screen.getByText(/don't have permission to view this incident's War Room/)).toBeInTheDocument();
  });

  it("shows Not started and an Open War Room button for an authorized manager", async () => {
    mockRoutes({ [`GET /incidents/${INCIDENT_ID}/war-room`]: () => NOT_STARTED });
    renderPanel();
    await screen.findByText("Not started");
    expect(screen.getByRole("button", { name: "Open War Room" })).toBeInTheDocument();
  });

  it("hides the Open button for a user without manage permission", async () => {
    mockRoutes({ [`GET /incidents/${INCIDENT_ID}/war-room`]: () => NOT_STARTED });
    renderPanel({ canManage: false });
    await screen.findByText("Not started");
    expect(screen.queryByRole("button", { name: "Open War Room" })).not.toBeInTheDocument();
  });

  it("opens the War Room on click", async () => {
    let opened = false;
    let getCount = 0;
    mockRoutes({
      [`GET /incidents/${INCIDENT_ID}/war-room`]: () => {
        getCount += 1;
        return opened
          ? { status: "open", id: "room-1", openedByDisplayName: "Admin User", openedAt: "2026-01-01T00:00:00.000Z", endedByDisplayName: null, endedAt: null, activeSessionCount: 0 }
          : NOT_STARTED;
      },
      [`POST /incidents/${INCIDENT_ID}/war-room/open`]: () => {
        opened = true;
        return { status: "open", id: "room-1", openedByDisplayName: "Admin User", openedAt: "2026-01-01T00:00:00.000Z", endedByDisplayName: null, endedAt: null, activeSessionCount: 0 };
      },
    });
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Open War Room" }));

    await screen.findByText("Open");
    expect(getCount).toBeGreaterThan(0);
  });

  it("shows a prejoin confirmation before actually joining, then joins", async () => {
    let joined = false;
    mockRoutes({
      [`GET /incidents/${INCIDENT_ID}/war-room`]: () =>
        joined
          ? { status: "open", id: "room-1", openedByDisplayName: "Admin User", openedAt: "2026-01-01T00:00:00.000Z", endedByDisplayName: null, endedAt: null, activeSessionCount: 1 }
          : { status: "open", id: "room-1", openedByDisplayName: "Admin User", openedAt: "2026-01-01T00:00:00.000Z", endedByDisplayName: null, endedAt: null, activeSessionCount: 0 },
      [`GET /incidents/${INCIDENT_ID}/war-room/sessions`]: () =>
        joined ? { items: [{ id: "s1", userId: CURRENT_USER_ID, displayName: "Admin User", status: "joined", joinedAt: "2026-01-01T00:01:00.000Z", leftAt: null }] } : { items: [] },
      [`POST /incidents/${INCIDENT_ID}/war-room/join`]: () => {
        joined = true;
        return { status: "open", id: "room-1", openedByDisplayName: "Admin User", openedAt: "2026-01-01T00:00:00.000Z", endedByDisplayName: null, endedAt: null, activeSessionCount: 1 };
      },
    });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Join War Room" }));
    await screen.findByText("INC-2026-000001 — Test Incident");
    expect(screen.getByText(/Joining as Admin User/)).toBeInTheDocument();

    const joinButtons = screen.getAllByRole("button", { name: "Join War Room" });
    fireEvent.click(joinButtons[joinButtons.length - 1]!);

    await waitFor(() => {
      expect(screen.getByText("You are in this War Room.")).toBeInTheDocument();
    });
    expect(screen.getByText(/Module 15/)).toBeInTheDocument();
  });

  it("does not show camera/microphone access or any provider chrome", async () => {
    mockRoutes({
      [`GET /incidents/${INCIDENT_ID}/war-room`]: () => ({
        status: "open",
        id: "room-1",
        openedByDisplayName: "Admin User",
        openedAt: "2026-01-01T00:00:00.000Z",
        endedByDisplayName: null,
        endedAt: null,
        activeSessionCount: 1,
      }),
      [`GET /incidents/${INCIDENT_ID}/war-room/sessions`]: () => ({
        items: [{ id: "s1", userId: CURRENT_USER_ID, displayName: "Admin User", status: "joined", joinedAt: "2026-01-01T00:01:00.000Z", leftAt: null }],
      }),
    });
    renderPanel();
    await screen.findByText("You are in this War Room.");
    expect(screen.queryByText(/camera/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/microphone/i)).not.toBeInTheDocument();
    expect(document.querySelector("video")).toBeNull();
  });

  it("hides Join controls once the Incident is closed", async () => {
    mockRoutes({
      [`GET /incidents/${INCIDENT_ID}/war-room`]: () => ({
        status: "open",
        id: "room-1",
        openedByDisplayName: "Admin User",
        openedAt: "2026-01-01T00:00:00.000Z",
        endedByDisplayName: null,
        endedAt: null,
        activeSessionCount: 0,
      }),
    });
    renderPanel({ isClosed: true });
    await screen.findByText("Open");
    expect(screen.queryByRole("button", { name: "Join War Room" })).not.toBeInTheDocument();
  });

  it("shows an ended-room summary with no Join/Open/End controls", async () => {
    mockRoutes({
      [`GET /incidents/${INCIDENT_ID}/war-room`]: () => ({
        status: "ended",
        id: "room-1",
        openedByDisplayName: "Admin User",
        openedAt: "2026-01-01T00:00:00.000Z",
        endedByDisplayName: "Admin User",
        endedAt: "2026-01-01T01:00:00.000Z",
        activeSessionCount: 0,
      }),
    });
    renderPanel();
    await screen.findByText(/This War Room ended/);
    expect(screen.queryByRole("button", { name: "Join War Room" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "End War Room" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open War Room" })).not.toBeInTheDocument();
  });
});
