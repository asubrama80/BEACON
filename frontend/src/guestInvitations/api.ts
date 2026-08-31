import { apiFetch } from "../lib/api";
import type { ApiErrorBody, CreateGuestInvitationResult, GuestInvitation, PublicInvitation } from "./types";

async function parseOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new Error(body.message ?? "Request failed.");
  }
  return body;
}

export async function listGuestInvitations(incidentId: string): Promise<GuestInvitation[]> {
  const response = await apiFetch(`/incidents/${incidentId}/guest-invitations`);
  const body = await parseOrThrow<{ items: GuestInvitation[] }>(response);
  return body.items;
}

export interface CreateGuestInvitationInput {
  guestName: string;
  email?: string;
  mobilePhone?: string;
  capabilities: { chat: boolean; warRoom: boolean };
}

export async function createGuestInvitation(incidentId: string, input: CreateGuestInvitationInput): Promise<CreateGuestInvitationResult> {
  const response = await apiFetch(`/incidents/${incidentId}/guest-invitations`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return parseOrThrow<CreateGuestInvitationResult>(response);
}

export async function revokeGuestInvitation(incidentId: string, invitationId: string): Promise<GuestInvitation> {
  const response = await apiFetch(`/incidents/${incidentId}/guest-invitations/${invitationId}/revoke`, { method: "POST" });
  return parseOrThrow<GuestInvitation>(response);
}

/** No session, no CSRF — the public pre-verification landing-page lookup. */
export async function getPublicInvitation(token: string): Promise<PublicInvitation> {
  const response = await apiFetch(`/guest/invitations/${encodeURIComponent(token)}`);
  return parseOrThrow<PublicInvitation>(response);
}
