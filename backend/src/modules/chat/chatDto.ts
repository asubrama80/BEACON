/** A single chat message — plain text only, never HTML. `authorType` distinguishes a registered
 * User from a verified Guest (Module 19); a Guest author never carries a `users` row. */
export interface ChatMessageDto {
  id: string;
  incidentId: string;
  seq: number;
  authorType: "user" | "guest";
  authorUserId: string | null;
  authorParticipantId: string | null;
  authorDisplayName: string;
  /** UI label hint — `true` only for `authorType: "guest"`, so the frontend can render a "Guest"
   * badge without inferring it from the id shape. */
  isGuest: boolean;
  messageText: string;
  createdAt: string;
}

export interface ChatMessageRow {
  id: string;
  incidentId: string;
  seq: number;
  authorType: string;
  userId: string | null;
  participantId: string | null;
  authorDisplayName: string | null;
  guestName: string | null;
  messageText: string;
  createdAt: Date;
}

export function toChatMessageDto(row: ChatMessageRow): ChatMessageDto {
  const isGuest = row.authorType === "guest";
  return {
    id: row.id,
    incidentId: row.incidentId,
    seq: row.seq,
    authorType: isGuest ? "guest" : "user",
    authorUserId: isGuest ? null : (row.userId ?? null),
    authorParticipantId: isGuest ? row.participantId : null,
    authorDisplayName: (isGuest ? row.guestName : row.authorDisplayName) ?? "Unknown",
    isGuest,
    messageText: row.messageText,
    createdAt: row.createdAt.toISOString(),
  };
}
