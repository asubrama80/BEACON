import { apiFetch } from "../lib/api";
import type {
  ApiErrorBody,
  Incident,
  IncidentSeverity,
  IncidentsListResponse,
  ParticipantsListResponse,
  TimelineListResponse,
} from "./types";

async function parseOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.message ?? "Request failed.");
  }
  return body;
}

export interface CreateIncidentInput {
  title: string;
  description?: string;
  severity: IncidentSeverity;
  commanderUserId?: string;
}

export interface UpdateIncidentInput {
  title?: string;
  description?: string;
  severity?: IncidentSeverity;
}

export async function listIncidents(params: {
  search?: string;
  status?: string;
  severity?: string;
  page?: number;
}): Promise<IncidentsListResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.status) query.set("status", params.status);
  if (params.severity) query.set("severity", params.severity);
  if (params.page) query.set("page", String(params.page));

  const response = await apiFetch(`/incidents?${query.toString()}`);
  return parseOrThrow<IncidentsListResponse>(response);
}

export async function getIncident(id: string): Promise<Incident> {
  const response = await apiFetch(`/incidents/${id}`);
  const body = await parseOrThrow<{ incident: Incident }>(response);
  return body.incident;
}

export async function createIncident(input: CreateIncidentInput): Promise<Incident> {
  const response = await apiFetch("/incidents", { method: "POST", body: JSON.stringify(input) });
  const body = await parseOrThrow<{ incident: Incident }>(response);
  return body.incident;
}

export async function updateIncident(id: string, input: UpdateIncidentInput): Promise<Incident> {
  const response = await apiFetch(`/incidents/${id}`, { method: "PATCH", body: JSON.stringify(input) });
  const body = await parseOrThrow<{ incident: Incident }>(response);
  return body.incident;
}

async function transition(id: string, action: "activate" | "resolve" | "close" | "reopen"): Promise<Incident> {
  const response = await apiFetch(`/incidents/${id}/${action}`, { method: "POST" });
  const body = await parseOrThrow<{ incident: Incident }>(response);
  return body.incident;
}

export const activateIncident = (id: string): Promise<Incident> => transition(id, "activate");
export const resolveIncident = (id: string): Promise<Incident> => transition(id, "resolve");
export const closeIncident = (id: string): Promise<Incident> => transition(id, "close");
export const reopenIncident = (id: string): Promise<Incident> => transition(id, "reopen");

export async function assignCommander(id: string, userId: string): Promise<Incident> {
  const response = await apiFetch(`/incidents/${id}/commander`, { method: "POST", body: JSON.stringify({ userId }) });
  const body = await parseOrThrow<{ incident: Incident }>(response);
  return body.incident;
}

export async function listParticipants(id: string, params: { page?: number } = {}): Promise<ParticipantsListResponse> {
  const query = new URLSearchParams();
  if (params.page) query.set("page", String(params.page));
  const response = await apiFetch(`/incidents/${id}/participants?${query.toString()}`);
  return parseOrThrow<ParticipantsListResponse>(response);
}

export async function addUserParticipant(id: string, userId: string): Promise<void> {
  const response = await apiFetch(`/incidents/${id}/participants/users`, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
  await parseOrThrow<{ added: boolean }>(response);
}

export async function addContactParticipant(id: string, contactId: string): Promise<void> {
  const response = await apiFetch(`/incidents/${id}/participants/contacts`, {
    method: "POST",
    body: JSON.stringify({ contactId }),
  });
  await parseOrThrow<{ added: boolean }>(response);
}

export async function removeParticipant(id: string, participantId: string): Promise<void> {
  const response = await apiFetch(`/incidents/${id}/participants/${participantId}`, { method: "DELETE" });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    throw new Error(body.message ?? "Unable to remove this participant.");
  }
}

export async function listTimeline(
  id: string,
  params: { page?: number; order?: "asc" | "desc" } = {},
): Promise<TimelineListResponse> {
  const query = new URLSearchParams();
  if (params.page) query.set("page", String(params.page));
  if (params.order) query.set("order", params.order);
  const response = await apiFetch(`/incidents/${id}/timeline?${query.toString()}`);
  return parseOrThrow<TimelineListResponse>(response);
}
