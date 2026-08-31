import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { safeEqual } from "../auth/session.js";
import { CSRF_INVALID } from "../auth/errors.js";
import type { GuestVerificationConfig } from "./config.js";

/** The exact double-submit-cookie pattern as `auth/csrf.ts`, on a separate cookie name — a
 * Guest's CSRF token is never interchangeable with a registered User's. */
export function generateGuestCsrfToken(): string {
  return randomBytes(24).toString("base64url");
}

export function setGuestCsrfCookie(reply: FastifyReply, token: string, config: GuestVerificationConfig, cookieSecure: boolean): void {
  reply.setCookie(config.guestCsrfCookieName, token, {
    httpOnly: false,
    sameSite: "lax",
    secure: cookieSecure,
    path: "/",
    maxAge: config.sessionTtlHours * 60 * 60,
  });
}

export function requireGuestCsrf(request: FastifyRequest, config: GuestVerificationConfig): void {
  const cookieToken = request.cookies[config.guestCsrfCookieName];
  const headerToken = request.headers["x-guest-csrf-token"];

  if (!cookieToken || typeof headerToken !== "string" || !safeEqual(cookieToken, headerToken)) {
    throw CSRF_INVALID;
  }
}
