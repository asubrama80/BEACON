import type { Database } from "@beacon/database";
import type { EmailProvider, ProviderSubmissionResult, SmsProvider } from "./providers/types.js";
import {
  claimRecipientForDispatch,
  completeDispatchAttempt,
  incrementRecipientAttempt,
  insertDispatchAttempt,
  markRecipientFailed,
  markRecipientSubmitted,
  type RecipientToDispatch,
} from "./dispatchQueries.js";

export interface DispatchEngineConfig {
  maxAttempts: number;
  retryBaseMs: number;
  concurrency: number;
  providerTimeoutMs: number;
}

export interface Providers {
  sms: SmsProvider;
  email: EmailProvider;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter — bounded, never used for an indefinite/unbounded wait. */
function backoffWithJitter(baseMs: number, attemptNumber: number): number {
  const exponential = baseMs * 2 ** (attemptNumber - 1);
  const jitter = Math.random() * baseMs;
  return Math.min(exponential + jitter, 30_000);
}

async function callProviderWithTimeout(
  send: () => Promise<ProviderSubmissionResult>,
  timeoutMs: number,
  providerName: string,
): Promise<ProviderSubmissionResult> {
  return Promise.race([
    send(),
    new Promise<ProviderSubmissionResult>((resolve) =>
      setTimeout(
        () =>
          resolve({
            accepted: false,
            provider: providerName,
            failureClass: "transient",
            errorCode: "timeout",
            safeErrorMessage: "Provider call exceeded the configured timeout.",
          }),
        timeoutMs,
      ),
    ),
  ]);
}

/**
 * Claims, submits, classifies, and (within a bounded retry budget) retries exactly one
 * recipient. Returns "skipped" when another caller already claimed this recipient — this is the
 * idempotency guarantee at work, not an error. Consumes only the frozen recipient snapshot
 * (`recipient.destination`/`renderedSubject`/`renderedBody`) — never a live Contact or Template.
 */
async function dispatchOneRecipient(
  db: Database,
  alertId: string,
  recipient: RecipientToDispatch,
  providers: Providers,
  config: DispatchEngineConfig,
): Promise<"submitted" | "submission_failed" | "skipped"> {
  const claimed = await claimRecipientForDispatch(db, recipient.id);
  if (!claimed) return "skipped";

  const provider = recipient.channel === "sms" ? providers.sms : providers.email;
  let attemptNumber = claimed.attemptCount;

  for (;;) {
    const attempt = await insertDispatchAttempt(db, {
      alertId,
      alertRecipientId: recipient.id,
      channel: recipient.channel,
      provider: provider.name,
      attemptNumber,
    });

    const send = (): Promise<ProviderSubmissionResult> =>
      recipient.channel === "sms"
        ? providers.sms.send({ idempotencyKey: recipient.id, destination: recipient.destination, body: recipient.renderedBody })
        : providers.email.send({
            idempotencyKey: recipient.id,
            destination: recipient.destination,
            subject: recipient.renderedSubject ?? "",
            body: recipient.renderedBody,
          });

    const result = await callProviderWithTimeout(send, config.providerTimeoutMs, provider.name);
    await completeDispatchAttempt(db, attempt.id, result);

    if (result.accepted) {
      await markRecipientSubmitted(db, recipient.id, result);
      return "submitted";
    }

    const isPermanent = result.failureClass === "permanent";
    const exhausted = attemptNumber >= config.maxAttempts;
    if (isPermanent || exhausted) {
      await markRecipientFailed(db, recipient.id, result);
      return "submission_failed";
    }

    await sleep(backoffWithJitter(config.retryBaseMs, attemptNumber));
    attemptNumber = await incrementRecipientAttempt(db, recipient.id);
  }
}

export interface DispatchBatchOutcome {
  submitted: number;
  submissionFailed: number;
  skipped: number;
}

/**
 * Processes recipients in bounded-size concurrent batches — never unlimited parallel outbound
 * calls, never one giant transaction held open across remote I/O. See module doc, "Concurrency
 * limits" and "Batch semantics".
 */
export async function dispatchRecipients(
  db: Database,
  alertId: string,
  recipients: RecipientToDispatch[],
  providers: Providers,
  config: DispatchEngineConfig,
): Promise<DispatchBatchOutcome> {
  const outcome: DispatchBatchOutcome = { submitted: 0, submissionFailed: 0, skipped: 0 };
  const concurrency = Math.max(1, config.concurrency);

  for (let i = 0; i < recipients.length; i += concurrency) {
    const batch = recipients.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((recipient) => dispatchOneRecipient(db, alertId, recipient, providers, config)));
    for (const result of results) {
      if (result === "submitted") outcome.submitted += 1;
      else if (result === "submission_failed") outcome.submissionFailed += 1;
      else outcome.skipped += 1;
    }
  }

  return outcome;
}
