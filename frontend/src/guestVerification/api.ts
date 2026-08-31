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
