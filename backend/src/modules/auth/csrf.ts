import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthConfig } from "./config.js";
import { safeEqual } from "./session.js";
import { CSRF_INVALID } from "./errors.js";

/**
 * Double-submit-cookie CSRF defense: a readable (non-HttpOnly) token is set as a cookie
 * alongside the session cookie at login. The frontend must echo it back via the
 * `x-csrf-token` header on every state-changing authenticated request; a cross-site request
 * cannot read the cookie to construct that header (same-origin policy), even though the
 * browser attaches cookies automatically. Combined with `SameSite=Lax` on both cookies.
 */
export function generateCsrfToken(): string {
  return randomBytes(24).toString("base64url");
}

export function setCsrfCookie(reply: FastifyReply, token: string, config: AuthConfig): void {
  reply.setCookie(config.csrfCookieName, token, {
    httpOnly: false,
    sameSite: "lax",
    secure: config.cookieSecure,
    path: "/",
    maxAge: config.sessionTtlSeconds,
  });
}

export function requireCsrf(request: FastifyRequest, config: AuthConfig): void {
  const cookieToken = request.cookies[config.csrfCookieName];
  const headerToken = request.headers["x-csrf-token"];

  if (!cookieToken || typeof headerToken !== "string" || !safeEqual(cookieToken, headerToken)) {
    throw CSRF_INVALID;
  }
}
