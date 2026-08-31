import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GuestChatPanel from "./GuestChatPanel";

const INCIDENT_ID = "99999999-9999-9999-9999-999999999999";

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sentFrames: Array<Record<string, unknown>> = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sentFrames.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  triggerMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function mockHistoryFetch(items: unknown[] = []): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ items, hasMore: false }) })),
  );
}

async function renderConnected(): Promise<MockWebSocket> {
  render(<GuestChatPanel incidentId={INCIDENT_ID} />);
  await waitFor(() => {
    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
  });
  const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
  expect(socket.url).toContain("/ws/guest/incidents/");
  socket.triggerOpen();
  await screen.findByText("Connected");
  return socket;
}

describe("GuestChatPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    MockWebSocket.instances = [];
  });

  it("connects to the Guest WebSocket endpoint (not the registered-User one) and loads history", async () => {
    mockHistoryFetch([
      {
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        incidentId: INCIDENT_ID,
        seq: 1,
        authorType: "guest",
        authorUserId: null,
        authorParticipantId: "participant-1",
        authorDisplayName: "Jane Guest",
        isGuest: true,
        messageText: "hello from a guest",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    vi.stubGlobal("WebSocket", MockWebSocket);
    await renderConnected();
    expect(screen.getByText("hello from a guest")).toBeInTheDocument();
    expect(screen.getByText("Guest")).toBeInTheDocument();
  });

  it("sends a message and clears the draft once acknowledged", async () => {
    mockHistoryFetch();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const socket = await renderConnected();

    fireEvent.change(screen.getByPlaceholderText("Message the response team…"), { target: { value: "guest reply" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(socket.sentFrames).toHaveLength(1));
    expect(socket.sentFrames[0]).toMatchObject({ type: "send", body: "guest reply" });

    const requestId = socket.sentFrames[0]!.requestId as string;
    socket.triggerMessage({
      type: "sent",
      requestId,
      message: {
        id: "bbbbbbbb-0000-0000-0000-000000000002",
        incidentId: INCIDENT_ID,
        seq: 2,
        authorType: "guest",
        authorUserId: null,
        authorParticipantId: "participant-1",
        authorDisplayName: "Jane Guest",
        isGuest: true,
        messageText: "guest reply",
        createdAt: "2026-01-01T00:01:00.000Z",
      },
    });

    await waitFor(() => expect(screen.getByPlaceholderText("Message the response team…")).toHaveValue(""));
  });
});
