import type { FailureClass, ProviderSubmissionResult, SmsProvider, SmsSendRequest } from "./types.js";
import type { TwilioCredentials } from "../config.js";

interface TwilioApiResponse {
  sid?: string;
  code?: number;
  message?: string;
}

/**
 * Twilio Programmable Messaging error codes that mean the request itself is invalid and will
 * never succeed on retry (e.g. malformed/unreachable destination) — classified `permanent`.
 * Anything else in the 4xx/5xx range not on this list is treated conservatively.
 */
const PERMANENT_TWILIO_CODES = new Set([21211, 21214, 21606, 21608, 21610, 21614, 21408, 21610]);

function classifyTwilioFailure(httpStatus: number, twilioCode: number | undefined): FailureClass {
  if (httpStatus === 429 || httpStatus >= 500) return "transient";
  if (twilioCode && PERMANENT_TWILIO_CODES.has(twilioCode)) return "permanent";
  if (httpStatus >= 400 && httpStatus < 500) return "permanent";
  return "transient";
}

/**
 * Real Twilio SMS adapter, using Twilio's REST API directly over `fetch` (Basic Auth) rather than
 * the full `twilio` SDK — keeps the dependency footprint minimal for a single documented HTTP
 * call. Consumes only the immutable Alert Recipient snapshot (destination + rendered body) —
 * never queries a Contact or Template. Never logs the destination or body. See
 * claude/prompts/10-notification-providers.md, "Twilio adapter".
 *
 * `statusCallbackUrl`, when provided (Module 11 integration — see
 * claude/prompts/11-delivery-tracking.md, "Twilio callback architecture"), is passed as Twilio's
 * `StatusCallback` param so delivery-status webhooks are requested for every submitted message.
 */
export function createTwilioSmsProvider(credentials: TwilioCredentials, timeoutMs: number, statusCallbackUrl?: string): SmsProvider {
  return {
    name: "twilio",
    async send(request: SmsSendRequest): Promise<ProviderSubmissionResult> {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url = `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Messages.json`;
        const bodyParams: Record<string, string> = { To: request.destination, From: credentials.fromNumber, Body: request.body };
        if (statusCallbackUrl) bodyParams.StatusCallback = statusCallbackUrl;
        const body = new URLSearchParams(bodyParams);
        const auth = Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString("base64");

        const response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
          signal: controller.signal,
        });

        const json = (await response.json().catch(() => ({}))) as TwilioApiResponse;

        if (response.ok && json.sid) {
          return { accepted: true, provider: "twilio", providerMessageId: json.sid };
        }

        return {
          accepted: false,
          provider: "twilio",
          failureClass: classifyTwilioFailure(response.status, json.code),
          errorCode: json.code ? String(json.code) : String(response.status),
          safeErrorMessage: "Twilio declined to accept the message.",
        };
      } catch (error) {
        const isTimeout = error instanceof Error && error.name === "AbortError";
        return {
          accepted: false,
          provider: "twilio",
          failureClass: "transient",
          errorCode: isTimeout ? "timeout" : "network_error",
          safeErrorMessage: isTimeout ? "Twilio request timed out." : "Twilio request failed.",
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
