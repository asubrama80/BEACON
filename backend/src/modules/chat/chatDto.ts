/** A single chat message — plain text only, never HTML. Module 13 supports registered-User
 * authorship only; `authorType` stays 'user' until a future module adds Guest chat. */
export interface ChatMessageDto {
  id: string;
  incidentId: string;
  seq: number;
  authorType: "user";
  authorUserId: string;
  authorDisplayName: string;
  messageText: string;
  createdAt: string;
}

export interface ChatMessageRow {
  id: string;
  incidentId: string;
  seq: number;
  authorType: string;
  userId: string | null;
  authorDisplayName: string | null;
  messageText: string;
  createdAt: Date;
}

export function toChatMessageDto(row: ChatMessageRow): ChatMessageDto {
  return {
    id: row.id,
    incidentId: row.incidentId,
    seq: row.seq,
    authorType: "user",
    authorUserId: row.userId ?? "",
    authorDisplayName: row.authorDisplayName ?? "Unknown",
    messageText: row.messageText,
    createdAt: row.createdAt.toISOString(),
  };
}
