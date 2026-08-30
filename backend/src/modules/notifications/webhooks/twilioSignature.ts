import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Official Twilio request-signature algorithm (hand-rolled — same minimal-dependency choice as
 * the Twilio SMS adapter in Module 10): sort POST param keys, append `key+value` (no separator)
 * to the exact externally-visible webhook URL, HMAC-SHA1 with the account auth token, base64.
 * See claude/prompts/11-delivery-tracking.md, "Twilio callback architecture".
 */
export function computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/** Constant-time comparison — never a `===` string check on secret-derived material. */
export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string): boolean {
  const expected = computeTwilioSignature(authToken, url, params);
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
