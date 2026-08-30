import { useCallback, useEffect, useState } from "react";
import { getWarRoom, listWarRoomSessions, openWarRoom, joinWarRoom, leaveWarRoom, endWarRoom } from "./api";
import type { WarRoom, WarRoomSession } from "./types";

const STATUS_LABEL: Record<string, string> = {
  not_started: "Not started",
  open: "Open",
  ended: "Ended",
};

const STATUS_BADGE: Record<string, string> = {
  not_started: "badge-neutral",
  open: "badge-success",
  ended: "badge-warning",
};

interface WarRoomPanelProps {
  incidentId: string;
  incidentNumber: string;
  incidentTitle: string;
  canRead: boolean;
  canManage: boolean;
  canJoin: boolean;
  isClosed: boolean;
  currentUserId: string;
  currentUserDisplayName: string;
}

/**
 * Provider-neutral by design — no camera/microphone access, no meeting URL, no RTC SDK anywhere
 * in this component. The media area is a fixed placeholder until Module 15. See
 * claude/prompts/14-war-room-foundation.md, "Critical architectural rule".
 */
export default function WarRoomPanel({
  incidentId,
  incidentNumber,
  incidentTitle,
  canRead,
  canManage,
  canJoin,
  isClosed,
  currentUserId,
  currentUserDisplayName,
}: WarRoomPanelProps): JSX.Element {
  const [warRoom, setWarRoom] = useState<WarRoom | null>(null);
  const [sessions, setSessions] = useState<WarRoomSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPrejoin, setShowPrejoin] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [room, sessionList] = await Promise.all([getWarRoom(incidentId), listWarRoomSessions(incidentId)]);
      setWarRoom(room);
      setSessions(sessionList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the War Room.");
    }
  }, [incidentId]);

  useEffect(() => {
    if (canRead) void refresh();
  }, [canRead, refresh]);

  async function runAction(fn: (id: string) => Promise<WarRoom>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn(incidentId);
      setShowPrejoin(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to complete this action.");
    } finally {
      setBusy(false);
    }
  }

  if (!canRead) {
    return <p className="cell-muted">You don't have permission to view this incident's War Room.</p>;
  }
  if (error && !warRoom) {
    return (
      <p className="error-banner" role="alert">
        {error}
      </p>
    );
  }
  if (!warRoom) {
    return <p>Loading…</p>;
  }

  const mySession = sessions.find((s) => s.userId === currentUserId && s.status === "joined");

  return (
    <div className="detail-section">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div className="detail-section-title" style={{ marginBottom: 0 }}>
          Incident War Room
        </div>
        <span className={`badge ${STATUS_BADGE[warRoom.status] ?? "badge-neutral"}`}>{STATUS_LABEL[warRoom.status]}</span>
      </div>

      {error && (
        <p className="error-banner" role="alert" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      {warRoom.status === "not_started" && (
        <>
          <p className="cell-muted">This Incident's War Room has not been started yet.</p>
          {canManage && !isClosed && (
            <div className="detail-actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void runAction(openWarRoom)}>
                Open War Room
              </button>
            </div>
          )}
        </>
      )}

      {warRoom.status === "open" && (
        <>
          <p className="cell-primary">
            {warRoom.activeSessionCount} currently in War Room · opened by {warRoom.openedByDisplayName ?? "—"}
            {warRoom.openedAt ? ` at ${new Date(warRoom.openedAt).toLocaleString()}` : ""}
          </p>

          {mySession ? (
            <>
              <p className="cell-muted">You are in this War Room.</p>
              <div
                className="card"
                style={{ padding: 16, marginTop: 8, marginBottom: 12, textAlign: "center", background: "var(--surface-alt, #f3f4f6)" }}
              >
                Audio/video becomes available in Module 15.
              </div>
              {canJoin && (
                <div className="detail-actions">
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void runAction(leaveWarRoom)}>
                    Leave War Room
                  </button>
                </div>
              )}
            </>
          ) : (
            canJoin &&
            !isClosed &&
            (showPrejoin ? (
              <div className="card" style={{ padding: 14, marginTop: 8 }}>
                <p className="cell-primary">
                  {incidentNumber} — {incidentTitle}
                </p>
                <p className="cell-muted">Joining as {currentUserDisplayName}.</p>
                <p className="cell-muted">Audio/video is not available yet — this join is text/roster only in this module.</p>
                <div className="form-actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowPrejoin(false)}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void runAction(joinWarRoom)}>
                    Join War Room
                  </button>
                </div>
              </div>
            ) : (
              <div className="detail-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowPrejoin(true)}>
                  Join War Room
                </button>
              </div>
            ))
          )}

          {canManage && (
            <div className="detail-actions" style={{ marginTop: 8 }}>
              <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void runAction(endWarRoom)}>
                End War Room
              </button>
            </div>
          )}
        </>
      )}

      {warRoom.status === "ended" && (
        <p className="cell-muted">
          This War Room ended{warRoom.endedAt ? ` ${new Date(warRoom.endedAt).toLocaleString()}` : ""}
          {warRoom.endedByDisplayName ? ` (ended by ${warRoom.endedByDisplayName})` : ""}.
        </p>
      )}

      {sessions.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Participant</th>
                <th>Status</th>
                <th>Joined</th>
                <th>Left</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="cell-primary">{s.displayName}</td>
                  <td>
                    <span className={`badge ${s.status === "joined" ? "badge-success" : "badge-neutral"}`}>{s.status}</span>
                  </td>
                  <td className="cell-muted">{new Date(s.joinedAt).toLocaleString()}</td>
                  <td className="cell-muted">{s.leftAt ? new Date(s.leftAt).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
