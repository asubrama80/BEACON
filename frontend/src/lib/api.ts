const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";
const CSRF_COOKIE_NAME = "beacon_csrf";

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  return document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
}

/**
 * Fetch wrapper for the BEACON API: always sends credentials (the session cookie), and
 * echoes the CSRF cookie back as a header on state-changing requests, matching the backend's
 * double-submit-cookie CSRF check.
 */
export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);

  if (method !== "GET" && method !== "HEAD") {
    const csrfToken = readCookie(CSRF_COOKIE_NAME);
    if (csrfToken) {
      headers.set("x-csrf-token", csrfToken);
    }
  }

  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(`${API_BASE_URL}${path}`, { ...options, headers, credentials: "include" });
}
