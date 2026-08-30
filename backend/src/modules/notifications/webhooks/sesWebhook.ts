import type { FastifyReply, FastifyRequest } from "fastify";
import { getDb } from "@beacon/database";
import { processDeliveryEvent } from "../deliveryService.js";
import type { NormalizedEventStatus } from "../deliveryStatus.js";
import { verifySnsSignature, type SnsMessage } from "./snsSignature.js";

interface SesMailObject {
  messageId?: string;
  timestamp?: string;
}

export interface SesEventEnvelope {
  eventType?: string;
  mail?: SesMailObject;
  delivery?: { timestamp?: string };
  bounce?: { bounceType?: string; bounceSubType?: string; timestamp?: string; feedbackId?: string };
  reject?: { reason?: string };
}

function safeParseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Maps a parsed SES event notification to the provider-neutral model. Only event types relevant
 * to delivery tracking are handled — `Send`, `Open`, `Click`, etc. are acknowledged and ignored.
 * See claude/prompts/11-delivery-tracking.md, "SES/SNS architecture".
 */
export function mapSesEvent(event: SesEventEnvelope):
  | {
      normalizedStatus: NormalizedEventStatus;
      occurredAt: Date;
      providerErrorCode?: string | undefined;
      safeErrorSummary?: string | undefined;
      providerEventId?: string | undefined;
    }
  | undefined {
  const now = new Date();
  if (event.eventType === "Delivery") {
    return { normalizedStatus: "delivered", occurredAt: safeParseDate(event.delivery?.timestamp) ?? now };
  }
  if (event.eventType === "Bounce") {
    const bounceType = event.bounce?.bounceType;
    const bounceSubType = event.bounce?.bounceSubType;
    return {
      normalizedStatus: "bounced",
      occurredAt: safeParseDate(event.bounce?.timestamp) ?? now,
      providerErrorCode: bounceType,
      safeErrorSummary: bounceType && bounceSubType ? `${bounceType}/${bounceSubType}` : bounceType,
      providerEventId: event.bounce?.feedbackId,
    };
  }
  if (event.eventType === "Reject") {
    return { normalizedStatus: "failed", occurredAt: now, providerErrorCode: event.reject?.reason };
  }
  return undefined;
}

/**
 * `POST /webhooks/ses/events` — ingests SES delivery/bounce/reject events delivered via an SNS
 * subscription (SES → Configuration Set/Event Destination → SNS → this endpoint; see module doc,
 * "SES event architecture" for why SES does not post here directly). Not session-authenticated;
 * authenticity comes from SNS message-signature verification.
 */
export function createSesEventsHandler(fetchCert?: (url: string) => Promise<string>) {
  return async function sesEventsHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    let snsMessage: SnsMessage;
    try {
      const raw = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
      snsMessage = JSON.parse(raw) as SnsMessage;
    } catch {
      reply.status(400).send({ error: "invalid_payload" });
      return;
    }

    if (snsMessage.Type === "SubscriptionConfirmation" || snsMessage.Type === "UnsubscribeConfirmation") {
      // Deliberately never auto-fetches SubscribeURL — SSRF-safe by construction. An operator
      // must complete subscription confirmation manually (AWS Console/CLI). See module doc,
      // "Security — SSRF" and "Local development callback limitation".
      reply.status(200).send({ ok: true, outcome: "subscription_ack_no_fetch" });
      return;
    }

    if (snsMessage.Type !== "Notification") {
      reply.status(200).send({ ok: true, outcome: "ignored_type" });
      return;
    }

    const validSignature = fetchCert ? await verifySnsSignature(snsMessage, fetchCert) : await verifySnsSignature(snsMessage);
    if (!validSignature) {
      reply.status(403).send({ error: "invalid_signature" });
      return;
    }

    let sesEvent: SesEventEnvelope;
    try {
      sesEvent = JSON.parse(snsMessage.Message) as SesEventEnvelope;
    } catch {
      reply.status(400).send({ error: "invalid_payload" });
      return;
    }

    const messageId = sesEvent.mail?.messageId;
    if (!messageId) {
      reply.status(400).send({ error: "invalid_payload" });
      return;
    }

    const mapped = mapSesEvent(sesEvent);
    if (!mapped) {
      reply.status(200).send({ ok: true, outcome: "ignored_event_type" });
      return;
    }

    const outcome = await processDeliveryEvent(getDb(), {
      provider: "ses",
      providerMessageId: messageId,
      providerEventId: mapped.providerEventId,
      rawProviderStatus: sesEvent.eventType ?? "unknown",
      normalizedStatus: mapped.normalizedStatus,
      occurredAt: mapped.occurredAt,
      providerErrorCode: mapped.providerErrorCode,
      safeErrorSummary: mapped.safeErrorSummary,
    });

    reply.status(200).send({ ok: true, outcome });
  };
}
