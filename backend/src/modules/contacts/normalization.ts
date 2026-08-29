import { parsePhoneNumberWithError, ParseError } from "libphonenumber-js";

export interface NormalizationResult<T> {
  valid: boolean;
  value?: T;
  reason?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalizes an email to its canonical stored form (trimmed, lowercased) and validates it
 * with a practical (not full RFC 5322) pattern. Never contacts an external mailbox-verification
 * service — this is purely offline shape validation. Rejects clearly invalid input rather than
 * silently coercing it into something that merely looks valid.
 */
export function normalizeEmail(input: string): NormalizationResult<string> {
  const trimmed = input.trim().toLowerCase();

  if (trimmed.length === 0) {
    return { valid: false, reason: "Email is required." };
  }
  if (trimmed.length > 255) {
    return { valid: false, reason: "Email must be 255 characters or fewer." };
  }
  if (!EMAIL_PATTERN.test(trimmed)) {
    return { valid: false, reason: "Email format is invalid." };
  }

  return { valid: true, value: trimmed };
}

/**
 * Normalizes a phone number to E.164 (e.g. "+15551234567") using `libphonenumber-js` — an
 * offline library with embedded numbering-plan metadata, never a network call. Defaults to US
 * parsing for a bare 10-digit number (this deployment's primary market) but a number that
 * already carries a country code (`+44...`, `011 44...`) is respected as-is, so international
 * numbers are not precluded. Rejects input that libphonenumber-js can't validate as a real
 * number, rather than storing a plausible-looking but wrong value.
 */
export function normalizePhone(input: string): NormalizationResult<string> {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return { valid: false, reason: "Phone number is required." };
  }

  try {
    const parsed = parsePhoneNumberWithError(trimmed, "US");
    if (!parsed.isValid()) {
      return { valid: false, reason: "Phone number is not valid." };
    }
    return { valid: true, value: parsed.number };
  } catch (error) {
    if (error instanceof ParseError) {
      return { valid: false, reason: "Phone number format is invalid." };
    }
    throw error;
  }
}
