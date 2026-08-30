export type WarRoomStatus = "not_started" | "open" | "ended";

/** Provider-neutral by design — no meeting URL, no media token, no provider name anywhere here.
 * See claude/prompts/14-war-room-foundation.md, "Provider-neutral architecture". */
export interface WarRoom {
  status: WarRoomStatus;
  id: string | null;
  openedByDisplayName: string | null;
  openedAt: string | null;
  endedByDisplayName: string | null;
  endedAt: string | null;
  activeSessionCount: number;
}

export interface WarRoomSession {
  id: string;
  userId: string | null;
  displayName: string;
  status: "joined" | "left";
  joinedAt: string;
  leftAt: string | null;
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}
