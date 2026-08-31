import { useCallback, useEffect, useState } from "react";
import { getGuestWarRoom, joinGuestWarRoom, leaveGuestWarRoom, type GuestWarRoom } from "./api";

const STATUS_LABEL: Record<string, string> = {
  not_started: "Not started",
  open: "Open",
  ended: "Ended",
};

interface GuestWarRoomPanelProps {
  incidentId: string;
}

/** The Guest-portal equivalent of `warRoom/WarRoomPanel.tsx` — foundation only, no RTC/camera/
 * microphone. See claude/prompts/19-participant-management.md, "Guest War Room". */
export default function GuestWarRoomPanel({ incidentId }: GuestWarRoomPanelProps): JSX.Element {
  const [room, setRoom] = useState<GuestWarRoom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRoom(await getGuestWarRoom(incidentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the War Room.");
    }
  }, [incidentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleJoin(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setRoom(await joinGuestWarRoom(incidentId));
      setJoined(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to join the War Room.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLeave(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setRoom(await leaveGuestWarRoom(incidentId));
      setJoined(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to leave the War Room.");
    } finally {
      setBusy(false);
    }
  }

  if (!room) {
    return (
      <div className="card" style={{ padding: 14, marginTop: 12 }}>
        <p className="cell-muted">Loading War Room…</p>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 14, marginTop: 12, textAlign: "left" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <strong>War Room</strong>
        <span className="badge badge-neutral">{STATUS_LABEL[room.status] ?? room.status}</span>
      </div>

      {error && <p className="error-banner">{error}</p>}

      {room.status === "not_started" && <p className="cell-muted">This incident's War Room has not been started yet.</p>}

      {room.status === "open" && (
        <>
          <p className="cell-muted">{room.activeSessionCount} currently in War Room.</p>
          {joined ? (
            <>
              <p className="cell-muted">You are in this War Room. Audio/video is not available yet.</p>
              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void handleLeave()}>
                Leave War Room
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void handleJoin()}>
              Join War Room
            </button>
          )}
        </>
      )}

      {room.status === "ended" && <p className="cell-muted">This War Room has ended.</p>}
    </div>
  );
}
