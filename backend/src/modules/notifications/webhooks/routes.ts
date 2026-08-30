import type { FastifyInstance } from "fastify";
import type { NotificationConfig } from "../config.js";
import { createTwilioStatusHandler } from "./twilioWebhook.js";
import { createSesEventsHandler } from "./sesWebhook.js";

interface WebhookRoutesOptions {
  notificationConfig: NotificationConfig;
  /** Test-only seam for injecting a synthetic SNS signing certificate — never set in production. */
  sesFetchCert?: (url: string) => Promise<string>;
}

/** Small, bounded — provider callback payloads are always small form/JSON documents. */
const WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Provider webhook routes — deliberately isolated from the rest of the application's routes.
 * Never session-authenticated, never CSRF-checked (a provider cannot present a BEACON session or
 * CSRF token); authenticity instead comes from provider-specific signature verification inside
 * each handler. Rate-limited generously (providers may burst many callbacks quickly) rather than
 * reusing the strict human-login throttle. See claude/prompts/11-delivery-tracking.md, "Webhook
 * routes" and "Webhook rate limiting".
 */
export async function webhooksRoutes(app: FastifyInstance, opts: WebhookRoutesOptions): Promise<void> {
  const { notificationConfig, sesFetchCert } = opts;

  // SNS posts its envelope as Content-Type: text/plain (even though the body is JSON) — Fastify
  // has no built-in parser for that combination, so this plugin-scoped parser reads it as a raw
  // string; the handler itself parses the JSON.
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_request, body, done) => {
    done(null, body);
  });

  app.post(
    "/webhooks/twilio/status",
    {
      bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
    },
    createTwilioStatusHandler(notificationConfig),
  );

  app.post(
    "/webhooks/ses/events",
    {
      bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
    },
    createSesEventsHandler(sesFetchCert),
  );
}
