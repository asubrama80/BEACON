import { render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GuestWarRoomPanel from "./GuestWarRoomPanel";

const INCIDENT_ID = "99999999-9999-9999-9999-999999999999";

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
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }),
  );
}

describe("GuestWarRoomPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows Not started when no room exists", async () => {
    mockRoutes({
      [`GET /guest/incidents/${INCIDENT_ID}/war-room`]: () => ({
        status: "not_started",
        id: null,
        openedByDisplayName: null,
        openedAt: null,
        endedByDisplayName: null,
        endedAt: null,
        activeSessionCount: 0,
      }),
    });
    render(<GuestWarRoomPanel incidentId={INCIDENT_ID} />);
    await screen.findByText("Not started");
  });

  it("joins an open room and shows a Leave action, with no camera/microphone chrome", async () => {
    let joined = false;
    mockRoutes({
      [`GET /guest/incidents/${INCIDENT_ID}/war-room`]: () => ({
        status: "open",
        id: "room-1",
        openedByDisplayName: "Admin User",
        openedAt: "2026-01-01T00:00:00.000Z",
        endedByDisplayName: null,
        endedAt: null,
        activeSessionCount: joined ? 1 : 0,
      }),
      [`POST /guest/incidents/${INCIDENT_ID}/war-room/join`]: () => {
        joined = true;
        return { status: "open", id: "room-1", openedByDisplayName: "Admin User", openedAt: "2026-01-01T00:00:00.000Z", endedByDisplayName: null, endedAt: null, activeSessionCount: 1 };
      },
    });
    render(<GuestWarRoomPanel incidentId={INCIDENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Join War Room" }));

    await screen.findByText("You are in this War Room. Audio/video is not available yet.");
    expect(screen.getByRole("button", { name: "Leave War Room" })).toBeInTheDocument();
    expect(screen.queryByText(/camera/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/microphone/i)).not.toBeInTheDocument();
    expect(document.querySelector("video")).toBeNull();
  });

  it("shows Ended for a closed-out room with no Join control", async () => {
    mockRoutes({
      [`GET /guest/incidents/${INCIDENT_ID}/war-room`]: () => ({
        status: "ended",
        id: "room-1",
        openedByDisplayName: "Admin User",
        openedAt: "2026-01-01T00:00:00.000Z",
        endedByDisplayName: "Admin User",
        endedAt: "2026-01-01T01:00:00.000Z",
        activeSessionCount: 0,
      }),
    });
    render(<GuestWarRoomPanel incidentId={INCIDENT_ID} />);
    await screen.findByText("This War Room has ended.");
    expect(screen.queryByRole("button", { name: "Join War Room" })).not.toBeInTheDocument();
  });
});
