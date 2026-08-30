import type { EmailProvider, EmailSendRequest, FailureClass, ProviderSubmissionResult, SmsProvider, SmsSendRequest } from "./types.js";

export interface MockOutcome {
  accepted: boolean;
  failureClass?: FailureClass;
  errorCode?: string;
  safeErrorMessage?: string;
}

/**
 * Test/dev-only hook for simulating provider outcomes. Never wired to any request/config path —
 * only test code importing this factory directly can supply a non-default resolver. See
 * claude/prompts/10-notification-providers.md, "Mock provider".
 */
export type MockOutcomeResolver = (request: { idempotencyKey: string; destination: string }) => MockOutcome;

const ALWAYS_ACCEPT: MockOutcomeResolver = () => ({ accepted: true });

function toResult(provider: string, idempotencyKey: string, outcome: MockOutcome): ProviderSubmissionResult {
  if (outcome.accepted) {
    // Deterministic, synthetic — never a real provider id, never derived from message content.
    return { accepted: true, provider, providerMessageId: `mock-${provider}-${idempotencyKey}` };
  }
  return {
    accepted: false,
    provider,
    failureClass: outcome.failureClass ?? "transient",
    errorCode: outcome.errorCode ?? "mock_simulated_failure",
    safeErrorMessage: outcome.safeErrorMessage ?? "Simulated failure from the mock provider.",
  };
}

/** Performs no network I/O. Never logs message body or destination. */
export function createMockSmsProvider(resolver: MockOutcomeResolver = ALWAYS_ACCEPT): SmsProvider {
  return {
    name: "mock",
    async send(request: SmsSendRequest): Promise<ProviderSubmissionResult> {
      const outcome = resolver({ idempotencyKey: request.idempotencyKey, destination: request.destination });
      return toResult("mock", request.idempotencyKey, outcome);
    },
  };
}

export function createMockEmailProvider(resolver: MockOutcomeResolver = ALWAYS_ACCEPT): EmailProvider {
  return {
    name: "mock",
    async send(request: EmailSendRequest): Promise<ProviderSubmissionResult> {
      const outcome = resolver({ idempotencyKey: request.idempotencyKey, destination: request.destination });
      return toResult("mock", request.idempotencyKey, outcome);
    },
  };
}
