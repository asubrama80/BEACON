import type { FastifyInstance } from "fastify";
import { getDb } from "@beacon/database";
import type { NotificationConfig } from "../notifications/config.js";
import type { GuestVerificationConfig } from "./config.js";
import { createAuthenticateGuestHook } from "./guestAuth.js";
import { generateGuestCsrfToken, setGuestCsrfCookie, requireGuestCsrf } from "./guestCsrf.js";
import { requestOtp, verifyOtp, logoutGuest, type RequestOtpOptions } from "./guestVerificationService.js";

interface GuestVerificationPublicRoutesOptions {
  config: GuestVerificationConfig;
  notificationConfig: NotificationConfig;
  cookieSecure: boolean;
  /** Test-only OTP capture seam — never set outside `buildTestApp()`. */
  onOtpGenerated?: RequestOtpOptions["onOtpGenerated"];
}

const TOKEN_PARAM_SCHEMA = {
  type: "object",
  required: ["token"],
  properties: { token: { type: "string", minLength: 1, maxLength: 512 } },
} as const;

const OTP_VERIFY_BODY_SCHEMA = {
  type: "object",
  required: ["code"],
  properties: { code: { type: "string", pattern: "^[0-9]{6}$" } },
} as const;

/**
 * Public, unauthenticated OTP request/verify routes plus the authenticated-Guest session routes —
 * no BEACON session exists until `/otp/verify` succeeds. Every route here is rate-limited (the
 * per-invitation cooldown/attempt-lockout in `guestVerificationService.ts` is the primary brute-
 * force defense; this is the per-IP layer). See claude/prompts/18-otp-verification.md, "APIs".
 */
export async function guestVerificationPublicRoutes(app: FastifyInstance, opts: GuestVerificationPublicRoutesOptions): Promise<void> {
  const { config, notificationConfig, cookieSecure, onOtpGenerated } = opts;
  const authenticateGuest = createAuthenticateGuestHook(config);

  app.post(
    "/guest/invitations/:token/otp/request",
    {
      schema: { params: TOKEN_PARAM_SCHEMA },
      config: { rateLimit: { max: config.otpRequestRateLimitMax, timeWindow: "1 minute" } },
    },
    async (request) => {
      const { token } = request.params as { token: string };
      return requestOtp(getDb(), config, notificationConfig, token, onOtpGenerated ? { onOtpGenerated } : {});
    },
  );

  app.post(
    "/guest/invitations/:token/otp/verify",
    {
      schema: { params: TOKEN_PARAM_SCHEMA, body: OTP_VERIFY_BODY_SCHEMA },
      config: { rateLimit: { max: config.otpVerifyRateLimitMax, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { token } = request.params as { token: string };
      const { code } = request.body as { code: string };
      const result = await verifyOtp(getDb(), config, token, code);

      reply.setCookie(config.guestSessionCookieName, result.sessionToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: cookieSecure,
        path: "/",
        maxAge: config.sessionTtlHours * 60 * 60,
      });
      setGuestCsrfCookie(reply, generateGuestCsrfToken(), config, cookieSecure);

      return { guestName: result.guestName, incidentId: result.incidentId, sessionExpiresAt: result.sessionExpiresAt };
    },
  );

  app.get("/guest/session", { preHandler: authenticateGuest }, async (request) => {
    const guest = request.authGuest!;
    return { guestName: guest.guestName, incidentId: guest.incidentId, capabilities: guest.capabilities };
  });

  app.post("/guest/session/logout", { preHandler: authenticateGuest }, async (request, reply) => {
    requireGuestCsrf(request, config);
    const guest = request.authGuest!;
    await logoutGuest(getDb(), guest.guestSessionId, guest.guestInvitationId, guest.incidentId);

    reply.clearCookie(config.guestSessionCookieName, { path: "/" });
    reply.clearCookie(config.guestCsrfCookieName, { path: "/" });

    return { success: true };
  });
}
