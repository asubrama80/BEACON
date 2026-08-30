export type SmsProviderName = "mock" | "twilio";
export type EmailProviderName = "mock" | "ses";

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export interface SesCredentials {
  region: string;
  fromAddress: string;
}

export interface NotificationConfig {
  smsProvider: SmsProviderName;
  emailProvider: EmailProviderName;
  twilio: TwilioCredentials | null;
  ses: SesCredentials | null;
  /** Bounded retry — never infinite. See module doc, "Retry behavior". */
  maxAttempts: number;
  retryBaseMs: number;
  /** Max simultaneous outbound provider calls for one dispatch operation. */
  dispatchConcurrency: number;
  /** Per-provider-call timeout — outbound requests must never hang indefinitely. */
  providerTimeoutMs: number;
  /**
   * The externally-visible base URL BEACON is reachable at — used to build the exact webhook
   * callback URL (`{publicBaseUrl}/webhooks/twilio/status`) both when submitting a Twilio SMS
   * (Module 10 integration) and when verifying that callback's signature (Module 11). Never
   * derived from arbitrary proxy headers. See claude/prompts/11-delivery-tracking.md, "Twilio
   * signature URL".
   */
  publicBaseUrl: string;
}

function readSmsProvider(value: string | undefined): SmsProviderName {
  if (value === "twilio") return "twilio";
  return "mock";
}

function readEmailProvider(value: string | undefined): EmailProviderName {
  if (value === "ses") return "ses";
  return "mock";
}

export function loadNotificationConfig(source: NodeJS.ProcessEnv = process.env): NotificationConfig {
  const smsProvider = readSmsProvider(source.SMS_PROVIDER);
  const emailProvider = readEmailProvider(source.EMAIL_PROVIDER);

  const twilio: TwilioCredentials | null =
    source.TWILIO_ACCOUNT_SID && source.TWILIO_AUTH_TOKEN && source.TWILIO_FROM_NUMBER
      ? { accountSid: source.TWILIO_ACCOUNT_SID, authToken: source.TWILIO_AUTH_TOKEN, fromNumber: source.TWILIO_FROM_NUMBER }
      : null;

  const ses: SesCredentials | null =
    source.AWS_REGION && source.SES_FROM_EMAIL ? { region: source.AWS_REGION, fromAddress: source.SES_FROM_EMAIL } : null;

  return {
    smsProvider,
    emailProvider,
    twilio,
    ses,
    maxAttempts: Number(source.PROVIDER_MAX_ATTEMPTS ?? 3),
    retryBaseMs: Number(source.PROVIDER_RETRY_BASE_MS ?? 500),
    dispatchConcurrency: Number(source.PROVIDER_DISPATCH_CONCURRENCY ?? 5),
    providerTimeoutMs: Number(source.PROVIDER_TIMEOUT_MS ?? 10000),
    publicBaseUrl: source.PUBLIC_BASE_URL ?? "http://localhost:4000",
  };
}
