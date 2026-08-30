export interface ChatMessage {
  id: string;
  incidentId: string;
  seq: number;
  authorType: "user";
  authorUserId: string;
  authorDisplayName: string;
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
