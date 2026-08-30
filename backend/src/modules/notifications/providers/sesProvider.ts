import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { EmailProvider, EmailSendRequest, FailureClass, ProviderSubmissionResult } from "./types.js";
import type { SesCredentials } from "../config.js";

/**
 * AWS error names that mean "try again later" rather than "this request can never succeed."
 * Anything else (e.g. `MessageRejected`, `MailFromDomainNotVerifiedException`) is permanent.
 */
const TRANSIENT_SES_ERROR_NAMES = new Set([
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
  "ServiceUnavailable",
  "ServiceUnavailableException",
  "RequestTimeout",
  "RequestTimeoutException",
]);

function classifySesFailure(error: unknown): { failureClass: FailureClass; errorCode: string } {
  const name = error instanceof Error ? error.name : "UnknownError";
  const httpStatus = (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata?.httpStatusCode;
  const transient = TRANSIENT_SES_ERROR_NAMES.has(name) || httpStatus === 429 || (httpStatus !== undefined && httpStatus >= 500);
  return { failureClass: transient ? "transient" : "permanent", errorCode: name };
}

/**
 * Real Amazon SES email adapter using the official AWS SDK v3 — standard credential-chain
 * resolution (environment, shared config, or workload identity later); no long-lived secrets
 * stored in the application database. Plain-text email only, consistent with Module 07. Consumes
 * only the immutable Alert Recipient snapshot — never queries a Contact or Template. Never logs
 * the destination, subject, or body. See claude/prompts/10-notification-providers.md,
 * "SES adapter".
 */
export function createSesEmailProvider(credentials: SesCredentials, timeoutMs: number): EmailProvider {
  const client = new SESClient({
    region: credentials.region,
    requestHandler: new NodeHttpHandler({ requestTimeout: timeoutMs, connectionTimeout: timeoutMs }),
  });

  return {
    name: "ses",
    async send(request: EmailSendRequest): Promise<ProviderSubmissionResult> {
      try {
        const command = new SendEmailCommand({
          Source: credentials.fromAddress,
          Destination: { ToAddresses: [request.destination] },
          Message: {
            Subject: { Data: request.subject, Charset: "UTF-8" },
            Body: { Text: { Data: request.body, Charset: "UTF-8" } },
          },
        });
        const result = await client.send(command);
        return result.MessageId
          ? { accepted: true, provider: "ses", providerMessageId: result.MessageId }
          : { accepted: true, provider: "ses" };
      } catch (error) {
        const { failureClass, errorCode } = classifySesFailure(error);
        return {
          accepted: false,
          provider: "ses",
          failureClass,
          errorCode,
          safeErrorMessage: "SES declined to accept the message.",
        };
      }
    },
  };
}
