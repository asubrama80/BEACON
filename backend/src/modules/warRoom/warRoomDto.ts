export type WarRoomStatus = "not_started" | "open" | "ended";

/** "not_started" is derived, not stored — see module doc, "Lifecycle". */
export interface WarRoomDto {
  status: WarRoomStatus;
  id: string | null;
  openedByDisplayName: string | null;
  openedAt: string | null;
  endedByDisplayName: string | null;
  endedAt: string | null;
  /** Only meaningful while status = "open" — always 0 for "not_started"/"ended". */
  activeSessionCount: number;
}

export interface WarRoomRow {
  id: string;
  status: string;
  openedByDisplayName: string | null;
  openedAt: Date;
  endedByDisplayName: string | null;
  endedAt: Date | null;
}

export function toWarRoomDto(row: WarRoomRow | undefined, activeSessionCount: number): WarRoomDto {
  if (!row) {
    return { status: "not_started", id: null, openedByDisplayName: null, openedAt: null, endedByDisplayName: null, endedAt: null, activeSessionCount: 0 };
  }
  return {
    status: row.status as WarRoomStatus,
    id: row.id,
    openedByDisplayName: row.openedByDisplayName,
    openedAt: row.openedAt.toISOString(),
    endedByDisplayName: row.endedByDisplayName,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    activeSessionCount: row.status === "open" ? activeSessionCount : 0,
  };
}

/** A session never carries any media/provider state — see module doc, "No fake media state".
 * `participantType` distinguishes a registered User from a verified Guest (Module 19). */
export interface WarRoomSessionDto {
  id: string;
  participantType: "user" | "guest";
  userId: string | null;
  displayName: string;
  isGuest: boolean;
  status: "joined" | "left";
  joinedAt: string;
  leftAt: string | null;
}

export interface WarRoomSessionRow {
  id: string;
  participantType: string;
  userId: string | null;
  guestInvitationId: string | null;
  displayName: string | null;
  guestName: string | null;
  status: string;
  joinedAt: Date;
  leftAt: Date | null;
}

export function toWarRoomSessionDto(row: WarRoomSessionRow): WarRoomSessionDto {
  const isGuest = row.participantType === "guest";
  return {
    id: row.id,
    participantType: isGuest ? "guest" : "user",
    userId: isGuest ? null : row.userId,
    displayName: (isGuest ? row.guestName : row.displayName) ?? "Unknown",
    isGuest,
    status: row.status as "joined" | "left",
    joinedAt: row.joinedAt.toISOString(),
    leftAt: row.leftAt ? row.leftAt.toISOString() : null,
  };
}
