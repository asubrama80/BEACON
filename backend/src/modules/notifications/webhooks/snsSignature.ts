import { createVerify } from "node:crypto";

/**
 * Only genuine AWS SNS-hosted signing certificates are ever fetched — see
 * claude/prompts/11-delivery-tracking.md, "Security — SSRF". Anything else (including a
 * plausible-looking lookalike domain) is rejected before any network request is made.
 */
const SNS_CERT_HOSTNAME_PATTERN = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

export interface SnsMessage {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
}

export function isTrustedSnsCertUrl(certUrl: string): boolean {
  try {
    const parsed = new URL(certUrl);
    return parsed.protocol === "https:" && SNS_CERT_HOSTNAME_PATTERN.test(parsed.hostname);
  } catch {
    return false;
  }
}

/** SNS's fixed field order/format per message Type — see AWS's "Verifying message signatures". */
export function buildStringToSign(msg: SnsMessage): string {
  const fields: [string, string | undefined][] =
    msg.Type === "Notification"
      ? [
          ["Message", msg.Message],
          ["MessageId", msg.MessageId],
          ["Subject", msg.Subject],
          ["Timestamp", msg.Timestamp],
          ["TopicArn", msg.TopicArn],
          ["Type", msg.Type],
        ]
      : [
          ["Message", msg.Message],
          ["MessageId", msg.MessageId],
          ["SubscribeURL", msg.SubscribeURL],
          ["Timestamp", msg.Timestamp],
          ["Token", msg.Token],
          ["TopicArn", msg.TopicArn],
          ["Type", msg.Type],
        ];

  let result = "";
  for (const [key, value] of fields) {
    if (value === undefined) continue;
    result += `${key}\n${value}\n`;
  }
  return result;
}

/** Bounded, no-redirect, hostname-allowlisted fetch of the signing certificate PEM. */
async function defaultFetchCert(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch SNS signing certificate: HTTP ${response.status}`);
  }
  return response.text();
}

/**
 * Verifies an SNS message's authenticity. Only SignatureVersion "1" (RSA-SHA1) is supported —
 * documented as a known limitation (SignatureVersion "2"/SHA256 support is a future addition, not
 * implemented since it cannot be exercised without real AWS traffic). `fetchCert` is injectable
 * so tests can supply a synthetic self-signed certificate — no real network call required.
 */
export async function verifySnsSignature(msg: SnsMessage, fetchCert: (url: string) => Promise<string> = defaultFetchCert): Promise<boolean> {
  if (msg.SignatureVersion !== "1") return false;
  if (!isTrustedSnsCertUrl(msg.SigningCertURL)) return false;

  let certPem: string;
  try {
    certPem = await fetchCert(msg.SigningCertURL);
  } catch {
    return false;
  }

  const stringToSign = buildStringToSign(msg);
  try {
    const verifier = createVerify("RSA-SHA1");
    verifier.update(stringToSign, "utf8");
    return verifier.verify(certPem, msg.Signature, "base64");
  } catch {
    return false;
  }
}
