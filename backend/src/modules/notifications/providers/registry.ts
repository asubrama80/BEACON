import type { NotificationConfig } from "../config.js";
import { createMockSmsProvider, createMockEmailProvider } from "./mockProvider.js";
import { createTwilioSmsProvider } from "./twilioProvider.js";
import { createSesEmailProvider } from "./sesProvider.js";
import type { EmailProvider, SmsProvider } from "./types.js";

/**
 * Centralized provider resolution — the only place that ever instantiates a Twilio/SES client.
 * Business dispatch logic must never construct a provider adapter directly. Called eagerly at
 * app startup (`buildApp`) so a misconfigured provider selection fails fast, before any Alert
 * ever attempts to dispatch. See claude/prompts/10-notification-providers.md, "Provider registry".
 */
export function getSmsProvider(config: NotificationConfig): SmsProvider {
  switch (config.smsProvider) {
    case "mock":
      return createMockSmsProvider();
    case "twilio":
      if (!config.twilio) {
        throw new Error(
          "SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER to be set.",
        );
      }
      return createTwilioSmsProvider(config.twilio, config.providerTimeoutMs);
    default:
      throw new Error(`Unsupported SMS_PROVIDER: ${config.smsProvider as string}`);
  }
}

export function getEmailProvider(config: NotificationConfig): EmailProvider {
  switch (config.emailProvider) {
    case "mock":
      return createMockEmailProvider();
    case "ses":
      if (!config.ses) {
        throw new Error("EMAIL_PROVIDER=ses requires AWS_REGION and SES_FROM_EMAIL to be set.");
      }
      return createSesEmailProvider(config.ses, config.providerTimeoutMs);
    default:
      throw new Error(`Unsupported EMAIL_PROVIDER: ${config.emailProvider as string}`);
  }
}

/** Safe, secret-free provider status — suitable for an admin-visible endpoint. */
export interface ProviderStatus {
  sms: { provider: string; configured: boolean };
  email: { provider: string; configured: boolean };
}

export function getProviderStatus(config: NotificationConfig): ProviderStatus {
  return {
    sms: { provider: config.smsProvider, configured: config.smsProvider === "mock" || config.twilio !== null },
    email: { provider: config.emailProvider, configured: config.emailProvider === "mock" || config.ses !== null },
  };
}
