import type { FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "@beacon/database";
import type { NotificationConfig } from "../config.js";
import { processDeliveryEvent } from "../deliveryService.js";
import type { NormalizedEventStatus } from "../deliveryStatus.js";
import { verifyTwilioSignature } from "./twilioSignature.js";

/**
 * Twilio's official Message Status values — see claude/prompts/11-delivery-tracking.md, "Twilio
 * callback architecture" for the exact mapping rationale. `receiving`/`received` (inbound
 * messages) are intentionally absent — BEACON never receives inbound SMS in this module.
 */
const TWILIO_STATUS_MAP: Record<string, NormalizedEventStatus> = {
  queued: "submitted",
  sending: "submitted",
  sent: "submitted",
  accepted: "submitted",
  delivered: "delivered",
  undelivered: "undelivered",
  failed: "failed",
};

/**
 * `POST /webhooks/twilio/status` handler. Not session-authenticated (Twilio cannot present a
 * BEACON session or CSRF token) — authenticity comes entirely from Twilio's request-signature
 * scheme. See claude/prompts/11-delivery-tracking.md, "Webhook routes".
 */
export function createTwilioStatusHandler(config: NotificationConfig) {
  return async function twilioStatusHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = (request.body ?? {}) as Record<string, string>;
    const signatureHeader = request.headers["x-twilio-signature"];

    if (typeof signatureHeader !== "string" || !config.twilio) {
      reply.status(403).send({ error: "invalid_signature" });
      return;
    }

    const callbackUrl = `${config.publicBaseUrl}/webhooks/twilio/status`;
    const valid = verifyTwilioSignature(config.twilio.authToken, callbackUrl, body, signatureHeader);
    if (!valid) {
      reply.status(403).send({ error: "invalid_signature" });
      return;
    }

    const messageSid = body.MessageSid;
    const messageStatus = body.MessageStatus;
    if (!messageSid || !messageStatus) {
      reply.status(400).send({ error: "invalid_payload" });
      return;
    }

    const normalized = TWILIO_STATUS_MAP[messageStatus];
    if (!normalized) {
      // Unrecognized/irrelevant status — acknowledge without processing, never trigger provider retries.
      reply.status(200).send({ ok: true, outcome: "ignored_status" });
      return;
    }

    const outcome = await processDeliveryEvent(getDb(), {
      provider: "twilio",
      providerMessageId: messageSid,
      rawProviderStatus: messageStatus,
      normalizedStatus: normalized,
      // Twilio's standard status callback carries no event timestamp field — ingestion time is
      // used for both occurredAt and receivedAt, documented explicitly (module doc, "Delivery
      // timestamps").
      occurredAt: new Date(),
      providerErrorCode: body.ErrorCode || undefined,
      safeErrorSummary: body.ErrorCode ? `Twilio error code ${body.ErrorCode}` : undefined,
    });

    // Always a safe 200 — including for "unknown_recipient" (section 20: never invite endless
    // provider retries for a permanently uncorrelatable callback).
    reply.status(200).send({ ok: true, outcome });
  };
}
