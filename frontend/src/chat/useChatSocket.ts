import { useEffect, useRef, useState } from "react";
import { listMessages, chatSocketUrl } from "./api";
import type { ChatConnectionState, ChatMessage } from "./types";

const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 15000;
const HISTORY_PAGE_SIZE = 50;

interface PendingSend {
  resolve: () => void;
  reject: (message: string) => void;
}

interface UseChatSocketOptions {
  incidentId: string;
  /** Only connects while true — e.g. the Chat tab is open and the caller has read access. */
  enabled: boolean;
}

export interface UseChatSocketResult {
  messages: ChatMessage[];
  connectionState: ChatConnectionState;
  error: string | null;
  hasMoreOlder: boolean;
  send: (body: string) => Promise<void>;
  loadOlder: () => Promise<void>;
  clearError: () => void;
}

/**
 * Owns the chat WebSocket connection lifecycle: connect, reconnect with capped exponential
 * backoff on drop, and — on every (re)connect — refetch history from the durable REST endpoint
 * rather than ever relying on the socket to replay missed messages. See
 * claude/prompts/13-realtime-incident-chat.md, "Reconnect".
 */
export function useChatSocket({ incidentId, enabled }: UseChatSocketOptions): UseChatSocketResult {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [connectionState, setConnectionState] = useState<ChatConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<Map<string, PendingSend>>(new Map());

  useEffect(() => {
    if (!enabled) {
      setConnectionState("disconnected");
      return;
    }

    let cancelled = false;

    async function connect(): Promise<void> {
      setConnectionState((prev) => (prev === "connected" ? "reconnecting" : "connecting"));
      try {
        const response = await listMessages(incidentId, { limit: HISTORY_PAGE_SIZE });
        if (cancelled) return;
        setMessages(response.items);
        setHasMoreOlder(response.hasMore);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load chat history.");
      }
      if (cancelled) return;

      const ws = new WebSocket(chatSocketUrl(incidentId));
      socketRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        setConnectionState("connected");
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(event.data) as Record<string, unknown>;
        } catch {
          return;
        }

        if (data.type === "message") {
          const message = data.message as ChatMessage;
          setMessages((current) => (current.some((m) => m.id === message.id) ? current : [...current, message]));
          return;
        }

        const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
        if (data.type === "sent") {
          // The server deliberately excludes the sender from the broadcast (it would otherwise
          // double-deliver the same message down this connection) — the "sent" ack carries the
          // full persisted message precisely so the sender can render their own message here.
          const message = data.message as ChatMessage | undefined;
          if (message) {
            setMessages((current) => (current.some((m) => m.id === message.id) ? current : [...current, message]));
          }
          if (requestId) {
            pendingRef.current.get(requestId)?.resolve();
            pendingRef.current.delete(requestId);
          }
          return;
        }
        if (data.type === "error") {
          const safeMessage = (typeof data.message === "string" ? data.message : undefined) ?? String(data.error ?? "Error");
          if (requestId && pendingRef.current.has(requestId)) {
            pendingRef.current.get(requestId)!.reject(safeMessage);
            pendingRef.current.delete(requestId);
          } else {
            setError(safeMessage);
          }
        }
      };

      ws.onclose = () => {
        socketRef.current = null;
        if (cancelled) return;
        setConnectionState("reconnecting");
        const attempt = reconnectAttemptRef.current + 1;
        reconnectAttemptRef.current = attempt;
        const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
        reconnectTimerRef.current = setTimeout(() => {
          if (!cancelled) void connect();
        }, delay);
      };
    }

    void connect();

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [incidentId, enabled]);

  function send(body: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = socketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject("Not connected — try again once reconnected.");
        return;
      }
      const requestId = crypto.randomUUID();
      pendingRef.current.set(requestId, { resolve, reject });
      ws.send(JSON.stringify({ type: "send", body, requestId }));
    });
  }

  async function loadOlder(): Promise<void> {
    const earliest = messages[0]?.seq;
    if (earliest === undefined) return;
    try {
      const response = await listMessages(incidentId, { before: earliest, limit: HISTORY_PAGE_SIZE });
      setMessages((current) => [...response.items, ...current]);
      setHasMoreOlder(response.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load older messages.");
    }
  }

  return { messages, connectionState, error, hasMoreOlder, send, loadOlder, clearError: () => setError(null) };
}
