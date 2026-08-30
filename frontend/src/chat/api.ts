import { apiFetch, apiWsUrl } from "../lib/api";
import type { ApiErrorBody, ChatMessagesResponse } from "./types";

async function parseOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.message ?? "Request failed.");
  }
  return body;
}

/** Cursor-based history — never loads an Incident's entire chat history in one call. */
export async function listMessages(
  incidentId: string,
  params: { before?: number; limit?: number } = {},
): Promise<ChatMessagesResponse> {
  const query = new URLSearchParams();
  if (params.before) query.set("before", String(params.before));
  if (params.limit) query.set("limit", String(params.limit));
  const response = await apiFetch(`/incidents/${incidentId}/chat/messages?${query.toString()}`);
  return parseOrThrow<ChatMessagesResponse>(response);
}

export function chatSocketUrl(incidentId: string): string {
  return apiWsUrl(`/ws/incidents/${incidentId}/chat`);
}
