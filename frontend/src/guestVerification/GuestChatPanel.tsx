import { useEffect, useRef, useState } from "react";
import { useChatSocket } from "../chat/useChatSocket";
import type { ChatConnectionState } from "../chat/types";
import { listGuestChatMessages, guestChatSocketUrl } from "./api";

const MAX_MESSAGE_LENGTH = 4000;

const CONNECTION_LABEL: Record<ChatConnectionState, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
};

interface GuestChatPanelProps {
  incidentId: string;
}

/** The Guest-portal equivalent of `chat/ChatPanel.tsx`, reusing the same `useChatSocket` hook
 * (connect/reconnect/backoff logic) pointed at the Guest-authenticated endpoints instead of the
 * registered-User ones. See claude/prompts/19-participant-management.md, "Guest chat". */
export default function GuestChatPanel({ incidentId }: GuestChatPanelProps): JSX.Element {
  const { messages, connectionState, error, hasMoreOlder, send, loadOlder, clearError } = useChatSocket({
    incidentId,
    enabled: true,
    listMessages: listGuestChatMessages,
    socketUrl: guestChatSocketUrl,
  });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  useEffect(() => {
    if (shouldAutoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  async function handleSend(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await send(body);
      setDraft("");
    } catch (err) {
      setSendError(typeof err === "string" ? err : "Unable to send this message.");
    } finally {
      setSending(false);
    }
  }

  const canComposeNow = connectionState === "connected";

  return (
    <div className="card" style={{ padding: 14, marginTop: 12, textAlign: "left" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <strong>Incident Chat</strong>
        <span className="badge badge-neutral">{CONNECTION_LABEL[connectionState]}</span>
      </div>

      {error && (
        <p className="error-banner" role="alert" onClick={clearError}>
          {error}
        </p>
      )}
      {sendError && <p className="error-banner">{sendError}</p>}

      {hasMoreOlder && (
        <div className="form-actions" style={{ justifyContent: "center", marginBottom: 8 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadOlder()}>
            Load older messages
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--line, #e2e2e2)", borderRadius: 8, padding: 10, marginBottom: 10 }}
      >
        {messages.length === 0 && <p className="cell-muted">No messages yet.</p>}
        {messages.map((message) => (
          <div key={message.id} style={{ marginBottom: 8 }}>
            <div className="cell-muted" style={{ fontSize: 12 }}>
              {message.authorDisplayName}
              {message.isGuest && (
                <span className="badge badge-neutral" style={{ marginLeft: 4, fontSize: 10 }}>
                  Guest
                </span>
              )}
            </div>
            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{message.messageText}</div>
          </div>
        ))}
      </div>

      <form onSubmit={(e) => void handleSend(e)} style={{ display: "flex", gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder={canComposeNow ? "Message the response team…" : "Connecting…"}
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
