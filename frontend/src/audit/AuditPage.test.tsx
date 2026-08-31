import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AuditPage from "./AuditPage";

function mockRoutes(overrides: Record<string, () => unknown> = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL) => {
      const url = new URL(String(input));
      const key = `GET ${url.pathname}${url.search}`;
      const exactMatch = overrides[key];
      if (exactMatch) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(exactMatch()) });
      }
      // Fall back to matching by pathname only, for callers that don't care about query details.
      const pathOnlyMatch = overrides[`GET ${url.pathname}`];
      if (pathOnlyMatch) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(pathOnlyMatch()) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [], nextCursor: null }) });
    }),
  );
}

const SAMPLE_EVENT = {
  id: "event-1",
  timestamp: "2026-01-01T12:00:00.000Z",
  eventType: "INCIDENT_CREATED",
  actor: { type: "user", id: "user-1", displayName: "Admin User" },
  resource: { type: "incident", id: "11111111-1111-1111-1111-111111111111" },
  incidentId: "11111111-1111-1111-1111-111111111111",
  metadata: { incidentNumber: "INC-2026-000001", severity: "warning" },
};

describe("AuditPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows an empty state when no events exist", async () => {
    mockRoutes();
    render(<AuditPage />);
    await screen.findByText("No audit activity recorded yet.");
  });

  it("renders an event row with actor badge, action, resource, and formatted metadata", async () => {
    mockRoutes({ "GET /audit": () => ({ items: [SAMPLE_EVENT], nextCursor: null }) });
    render(<AuditPage />);
    const nameCell = await screen.findByText("Admin User");
    const row = nameCell.closest("tr")!;
    expect(within(row).getByText("User")).toBeInTheDocument();
    expect(within(row).getByText("INCIDENT_CREATED")).toBeInTheDocument();
    expect(within(row).getByText(/incident \(11111111/)).toBeInTheDocument();
    expect(within(row).getByText(/incidentNumber: INC-2026-000001/)).toBeInTheDocument();
  });

  it("shows a Guest actor badge distinctly", async () => {
    mockRoutes({
      "GET /audit": () => ({
        items: [{ ...SAMPLE_EVENT, id: "event-2", eventType: "GUEST_VERIFICATION_SUCCEEDED", actor: { type: "guest", id: "inv-1", displayName: "Jane Guest" } }],
        nextCursor: null,
      }),
    });
    render(<AuditPage />);
    const nameCell = await screen.findByText("Jane Guest");
    const row = nameCell.closest("tr")!;
    expect(within(row).getByText("Guest")).toBeInTheDocument();
  });

  it("loads more events via the cursor and appends them", async () => {
    mockRoutes({
      "GET /audit": () => ({ items: [SAMPLE_EVENT], nextCursor: "cursor-abc" }),
      "GET /audit?cursor=cursor-abc": () => ({ items: [{ ...SAMPLE_EVENT, id: "event-2", eventType: "INCIDENT_UPDATED" }], nextCursor: null }),
    });
    render(<AuditPage />);
    await screen.findByText("INCIDENT_CREATED");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("INCIDENT_UPDATED");
    expect(screen.getByText("INCIDENT_CREATED")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("re-fetches when the event type filter changes", async () => {
    const fetchMock = vi.fn((input: string | URL) => {
      const url = new URL(String(input));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ items: url.search.includes("eventType=LOGIN") ? [{ ...SAMPLE_EVENT, eventType: "LOGIN_SUCCESS" }] : [], nextCursor: null }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AuditPage />);
    await screen.findByText("No audit activity recorded yet.");

    fireEvent.change(screen.getByPlaceholderText(/Filter by event type/), { target: { value: "LOGIN_SUCCESS" } });
    await waitFor(() => expect(screen.getByText("LOGIN_SUCCESS")).toBeInTheDocument());
  });

  it("shows an error banner on a failed request", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({ error: "not_authorized", message: "You do not have permission to do that." }) })),
    );
    render(<AuditPage />);
    await screen.findByText("You do not have permission to do that.");
  });
});
