import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ChatPanel from "./ChatPanel";

const INCIDENT_ID = "99999999-9999-9999-9999-999999999999";
const CURRENT_USER_ID = "11111111-1111-1111-1111-111111111111";

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

async function renderConnected(props: Partial<Parameters<typeof ChatPanel>[0]> = {}): Promise<MockWebSocket> {
  render(
    <ChatPanel
      incidentId={INCIDENT_ID}
      canRead={true}
      canSend={true}
      isClosed={false}
      currentUserId={CURRENT_USER_ID}
      {...props}
    />,
  );
  await waitFor(() => {
    expect(MockWebSocket.instances.length).toBeGreaterThan(0);
  });
  const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1]!;
  socket.triggerOpen();
  await screen.findByText("Connected");
  return socket;
}

describe("ChatPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    MockWebSocket.instances = [];
  });

  it("shows read-only messaging when the caller lacks incidents.chat.read", () => {
    mockHistoryFetch();
    vi.stubGlobal("WebSocket", MockWebSocket);
    render(<ChatPanel incidentId={INCIDENT_ID} canRead={false} canSend={false} isClosed={false} currentUserId={CURRENT_USER_ID} />);
    expect(screen.getByText(/don't have permission to view this incident's chat/)).toBeInTheDocument();
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("loads history, connects, and shows the Connected badge", async () => {
    mockHistoryFetch([
      {
        id: "aaaaaaaa-0000-0000-0000-000000000001",
        incidentId: INCIDENT_ID,
        seq: 1,
        authorType: "user",
        authorUserId: CURRENT_USER_ID,
        authorDisplayName: "Admin User",
        messageText: "earlier message",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    vi.stubGlobal("WebSocket", MockWebSocket);
    await renderConnected();
    expect(screen.getByText("earlier message")).toBeInTheDocument();
  });

  it("renders an incoming broadcast message without HTML injection (XSS-shaped body stays inert text)", async () => {
    mockHistoryFetch();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const socket = await renderConnected();

    socket.triggerMessage({
      type: "message",
      message: {
        id: "bbbbbbbb-0000-0000-0000-000000000002",
        incidentId: INCIDENT_ID,
        seq: 2,
        authorType: "user",
        authorUserId: "other-user",
        authorDisplayName: "Other Responder",
        messageText: "<img src=x onerror=alert(1)>",
        createdAt: "2026-01-01T00:01:00.000Z",
      },
    });

    const rendered = await screen.findByText("<img src=x onerror=alert(1)>");
    expect(rendered.innerHTML).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(document.querySelector("img[onerror]")).toBeNull();
  });

  it("sends a message on submit and clears the draft once acknowledged", async () => {
    mockHistoryFetch();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const socket = await renderConnected();

    fireEvent.change(screen.getByPlaceholderText("Message the response team…"), { target: { value: "hello team" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(socket.sentFrames).toHaveLength(1);
    });
    expect(socket.sentFrames[0]).toMatchObject({ type: "send", body: "hello team" });
    const requestId = socket.sentFrames[0]!.requestId as string;

    socket.triggerMessage({ type: "sent", requestId });

    await waitFor(() => {
      expect((screen.getByPlaceholderText("Message the response team…") as HTMLInputElement).value).toBe("");
    });
  });

  it("renders the sender's own message from the 'sent' ack (the server excludes the sender from its broadcast)", async () => {
    mockHistoryFetch();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const socket = await renderConnected();

    fireEvent.change(screen.getByPlaceholderText("Message the response team…"), { target: { value: "my own message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(socket.sentFrames).toHaveLength(1));
    const requestId = socket.sentFrames[0]!.requestId as string;

    socket.triggerMessage({
      type: "sent",
      requestId,
      message: {
        id: "cccccccc-0000-0000-0000-000000000003",
        incidentId: INCIDENT_ID,
        seq: 3,
        authorType: "user",
        authorUserId: CURRENT_USER_ID,
        authorDisplayName: "Admin User",
        messageText: "my own message",
        createdAt: "2026-01-01T00:02:00.000Z",
      },
    });

    await screen.findByText("my own message");
  });

  it("disables the compose input when the incident is closed", async () => {
    mockHistoryFetch();
    vi.stubGlobal("WebSocket", MockWebSocket);
    await renderConnected({ isClosed: true });

    expect(screen.getByText(/This incident is closed/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Chat is unavailable/)).toBeDisabled();
  });

  it("disables the compose input for a user without incidents.chat.send", async () => {
    mockHistoryFetch();
    vi.stubGlobal("WebSocket", MockWebSocket);
    await renderConnected({ canSend: false });

    expect(screen.getByText(/don't have permission to send messages/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Chat is unavailable/)).toBeDisabled();
  });

  it("shows a rate-limited/error response without crashing", async () => {
    mockHistoryFetch();
    vi.stubGlobal("WebSocket", MockWebSocket);
    const socket = await renderConnected();

    fireEvent.change(screen.getByPlaceholderText("Message the response team…"), { target: { value: "spam" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(socket.sentFrames).toHaveLength(1));
    const requestId = socket.sentFrames[0]!.requestId as string;

    socket.triggerMessage({ type: "error", error: "rate_limited", requestId, message: "Slow down." });

    await screen.findByText("Slow down.");
  });
});
