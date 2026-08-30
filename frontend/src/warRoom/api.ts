import { apiFetch } from "../lib/api";
import type { ApiErrorBody, WarRoom, WarRoomSession } from "./types";

async function parseOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.message ?? "Request failed.");
  }
  return body;
}

export async function getWarRoom(incidentId: string): Promise<WarRoom> {
  const response = await apiFetch(`/incidents/${incidentId}/war-room`);
  return parseOrThrow<WarRoom>(response);
}

export async function listWarRoomSessions(incidentId: string): Promise<WarRoomSession[]> {
  const response = await apiFetch(`/incidents/${incidentId}/war-room/sessions`);
  const body = await parseOrThrow<{ items: WarRoomSession[] }>(response);
  return body.items;
}

async function action(incidentId: string, verb: "open" | "join" | "leave" | "end"): Promise<WarRoom> {
  const response = await apiFetch(`/incidents/${incidentId}/war-room/${verb}`, { method: "POST" });
  return parseOrThrow<WarRoom>(response);
}

export const openWarRoom = (incidentId: string): Promise<WarRoom> => action(incidentId, "open");
export const joinWarRoom = (incidentId: string): Promise<WarRoom> => action(incidentId, "join");
export const leaveWarRoom = (incidentId: string): Promise<WarRoom> => action(incidentId, "leave");
export const endWarRoom = (incidentId: string): Promise<WarRoom> => action(incidentId, "end");
