export type FailureClass = "transient" | "permanent";

/**
 * Provider-neutral outcome — adapters never return raw provider responses. `accepted: true`
 * means only "the provider accepted the message for delivery," never that a human received it.
 * See claude/prompts/10-notification-providers.md, "Provider result model".
 */
export interface ProviderSubmissionResult {
  accepted: boolean;
  provider: string;
  providerMessageId?: string;
  failureClass?: FailureClass;
  errorCode?: string;
  /** Safe for storage/display — never a raw provider error body. */
  safeErrorMessage?: string;
}

/** Built only from the immutable `alert_recipients` snapshot — never a live Contact/Template. */
export interface SmsSendRequest {
  /** Stable per-recipient correlation key (the alert_recipient id) for provider-side idempotency. */
  idempotencyKey: string;
  destination: string;
  body: string;
}

export interface EmailSendRequest {
  idempotencyKey: string;
  destination: string;
  subject: string;
  body: string;
}

export interface SmsProvider {
  readonly name: string;
  send(request: SmsSendRequest): Promise<ProviderSubmissionResult>;
}

export interface EmailProvider {
  readonly name: string;
  send(request: EmailSendRequest): Promise<ProviderSubmissionResult>;
}
