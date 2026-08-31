export interface ChatMessage {
  id: string;
  incidentId: string;
  seq: number;
  authorType: "user" | "guest";
  authorUserId: string | null;
  authorParticipantId: string | null;
  authorDisplayName: string;
  isGuest: boolean;
  messageText: string;
  createdAt: string;
}

export interface ChatMessagesResponse {
  items: ChatMessage[];
  hasMore: boolean;
}

export type ChatConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

export interface ApiErrorBody {
  error?: string;
  message?: string;
}
