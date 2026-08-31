const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";
const GUEST_CSRF_COOKIE_NAME = "beacon_guest_csrf";

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  return document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
}

/** Mirrors `lib/api.ts`'s `apiFetch` exactly, but echoes the *Guest* CSRF cookie/header pair — a
 * Guest session is never authenticated via the registered-User session cookie. */
async function guestApiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);

  if (method !== "GET" && method !== "HEAD") {
    const csrfToken = readCookie(GUEST_CSRF_COOKIE_NAME);
    if (csrfToken) {
      headers.set("x-guest-csrf-token", csrfToken);
    }
  }
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(`${API_BASE_URL}${path}`, { ...options, headers, credentials: "include" });
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}

async function parseOrThrow<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw Object.assign(new Error(body.message ?? "Request failed."), { code: body.error });
  }
  return body;
}

export interface OtpRequestedResult {
  maskedDestination: string;
  resendAvailableAt: string;
  otpExpiresAt: string;
}

export async function requestGuestOtp(token: string): Promise<OtpRequestedResult> {
  const response = await guestApiFetch(`/guest/invitations/${encodeURIComponent(token)}/otp/request`, { method: "POST" });
  return parseOrThrow<OtpRequestedResult>(response);
}

export interface VerifyGuestOtpResult {
  guestName: string;
  incidentId: string;
  sessionExpiresAt: string;
}

export async function verifyGuestOtp(token: string, code: string): Promise<VerifyGuestOtpResult> {
  const response = await guestApiFetch(`/guest/invitations/${encodeURIComponent(token)}/otp/verify`, {
    method: "POST",
    body: JSON.stringify({ code }),
  });
  return parseOrThrow<VerifyGuestOtpResult>(response);
}

export interface GuestSessionInfo {
  guestName: string;
  incidentId: string;
  capabilities: { chat: boolean; warRoom: boolean };
}

export async function getGuestSession(): Promise<GuestSessionInfo | null> {
  const response = await guestApiFetch("/guest/session");
  if (response.status === 401) return null;
  return parseOrThrow<GuestSessionInfo>(response);
}

export async function guestLogout(): Promise<void> {
  await guestApiFetch("/guest/session/logout", { method: "POST" });
}

// ---------------------------------------------------------------------------------------------
// Module 19 — Guest Chat and War Room, reusing the same cookie/CSRF pattern as everything above.

export interface GuestChatMessage {
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

export interface GuestChatMessagesResponse {
  items: GuestChatMessage[];
  hasMore: boolean;
}

export async function listGuestChatMessages(
  incidentId: string,
  params: { before?: number; limit?: number } = {},
): Promise<GuestChatMessagesResponse> {
  const query = new URLSearchParams();
  if (params.before) query.set("before", String(params.before));
  if (params.limit) query.set("limit", String(params.limit));
  const response = await guestApiFetch(`/guest/incidents/${incidentId}/chat/messages?${query.toString()}`);
  return parseOrThrow<GuestChatMessagesResponse>(response);
}

export function guestChatSocketUrl(incidentId: string): string {
  return `${API_BASE_URL.replace(/^http/, "ws")}/ws/guest/incidents/${incidentId}/chat`;
}

export interface GuestWarRoom {
  status: "not_started" | "open" | "ended";
  id: string | null;
  openedByDisplayName: string | null;
  openedAt: string | null;
  endedByDisplayName: string | null;
  endedAt: string | null;
  activeSessionCount: number;
}

export async function getGuestWarRoom(incidentId: string): Promise<GuestWarRoom> {
  const response = await guestApiFetch(`/guest/incidents/${incidentId}/war-room`);
  return parseOrThrow<GuestWarRoom>(response);
}

export async function joinGuestWarRoom(incidentId: string): Promise<GuestWarRoom> {
  const response = await guestApiFetch(`/guest/incidents/${incidentId}/war-room/join`, { method: "POST" });
  return parseOrThrow<GuestWarRoom>(response);
}

export async function leaveGuestWarRoom(incidentId: string): Promise<GuestWarRoom> {
  const response = await guestApiFetch(`/guest/incidents/${incidentId}/war-room/leave`, { method: "POST" });
  return parseOrThrow<GuestWarRoom>(response);
}
