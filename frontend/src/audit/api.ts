import { apiFetch } from "../lib/api";
import type { ApiErrorBody, AuditFilters, AuditSearchResponse } from "./types";

async function parseOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.message ?? "Request failed.");
  }
  return body;
}

export async function searchAudit(filters: AuditFilters, cursor?: string | null): Promise<AuditSearchResponse> {
  const query = new URLSearchParams();
  if (filters.eventType) query.set("eventType", filters.eventType);
  if (filters.actorType) query.set("actorType", filters.actorType);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  if (cursor) query.set("cursor", cursor);
  const response = await apiFetch(`/audit?${query.toString()}`);
  return parseOrThrow<AuditSearchResponse>(response);
}
