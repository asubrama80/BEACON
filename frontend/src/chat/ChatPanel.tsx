import { useEffect, useRef, useState } from "react";
import { useChatSocket } from "./useChatSocket";
import type { ChatConnectionState } from "./types";

const MAX_MESSAGE_LENGTH = 4000;

const CONNECTION_LABEL: Record<ChatConnectionState, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

const CONNECTION_BADGE: Record<ChatConnectionState, string> = {
  connecting: "badge-neutral",
  connected: "badge-success",
  reconnecting: "badge-warning",
  disconnected: "badge-neutral",
};

interface ChatPanelProps {
  incidentId: string;
  canRead: boolean;
  canSend: boolean;
  isClosed: boolean;
  currentUserId: string;
}

/**
 * Plain-text incident chat — message bodies are rendered only as React text children, never via
 * `dangerouslySetInnerHTML`, so an XSS-shaped body (e.g. `<script>...`) is always inert. See
 * claude/prompts/13-realtime-incident-chat.md, "XSS safety".
 */
export default function ChatPanel({ incidentId, canRead, canSend, isClosed, currentUserId }: ChatPanelProps): JSX.Element {
  const { messages, connectionState, error, hasMoreOlder, send, loadOlder, clearError } = useChatSocket({
    incidentId,
    enabled: canRead,
  });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  useEffect(() => {
    if (shouldAutoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    shouldAutoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  async function handleLoadOlder(): Promise<void> {
    setLoadingOlder(true);
    shouldAutoScroll.current = false;
    try {
      await loadOlder();
    } finally {
      setLoadingOlder(false);
    }
  }

  async function handleSend(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    shouldAutoScroll.current = true;
    try {
      await send(body);
      setDraft("");
    } catch (err) {
      setSendError(typeof err === "string" ? err : "Unable to send this message.");
    } finally {
      setSending(false);
    }
  }

  if (!canRead) {
    return <p className="cell-muted">You don't have permission to view this incident's chat.</p>;
  }

  const canComposeNow = canSend && !isClosed && connectionState === "connected";

  return (
    <div className="detail-section">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div className="detail-section-title" style={{ marginBottom: 0 }}>
          Incident Chat
        </div>
        <span className={`badge ${CONNECTION_BADGE[connectionState]}`}>{CONNECTION_LABEL[connectionState]}</span>
      </div>

      {isClosed && <p className="warning-banner">This incident is closed. Chat history remains visible, but new messages can no longer be sent.</p>}
      {!isClosed && !canSend && <p className="cell-muted">You can view this chat, but you don't have permission to send messages.</p>}

      {error && (
        <p className="error-banner" role="alert" onClick={clearError}>
          {error}
        </p>
      )}
      {sendError && (
        <p className="error-banner" role="alert" onClick={() => setSendError(null)}>
          {sendError}
        </p>
      )}

      {hasMoreOlder && (
        <div className="form-actions" style={{ justifyContent: "center", marginBottom: 8 }}>
          <button type="button" className="btn btn-secondary btn-sm" disabled={loadingOlder} onClick={() => void handleLoadOlder()}>
            {loadingOlder ? "Loading…" : "Load older messages"}
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ maxHeight: 320, overflowY: "auto", border: "1px solid var(--line, #e2e2e2)", borderRadius: 8, padding: 12, marginBottom: 12 }}
      >
        {messages.length === 0 && <p className="cell-muted">No messages yet.</p>}
        {messages.map((message) => {
          const isMe = message.authorUserId === currentUserId;
          return (
            <div key={message.id} style={{ marginBottom: 10, textAlign: isMe ? "right" : "left" }}>
              <div className="cell-muted" style={{ fontSize: 12, marginBottom: 2 }}>
                {message.authorDisplayName} · {new Date(message.createdAt).toLocaleTimeString()}
              </div>
              <div
                style={{
                  display: "inline-block",
                  maxWidth: "85%",
                  padding: "8px 12px",
                  borderRadius: 10,
                  background: isMe ? "var(--brand-soft, #dbeafe)" : "var(--surface-alt, #f3f4f6)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  textAlign: "left",
                }}
              >
                {message.messageText}
              </div>
            </div>
          );
        })}
      </div>

      <form onSubmit={(e) => void handleSend(e)} style={{ display: "flex", gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder={canComposeNow ? "Message the response team…" : "Chat is unavailable right now"}
          value={draft}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={!canComposeNow || sending}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!canComposeNow || sending || !draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
