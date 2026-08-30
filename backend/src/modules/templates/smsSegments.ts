/**
 * SMS length/segment guidance (GSM 03.38 default alphabet vs. UCS-2), used only to help an
 * operator judge "will this send as one text or several" — never treated as carrier-billing-
 * authoritative. Deliberately a small hand-written utility rather than a new dependency: the
 * character-set membership check and segment-size arithmetic below are the entire algorithm.
 */

// GSM 03.38 default alphabet (single-byte-cost characters).
const GSM_BASIC_CHARS =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
// GSM 03.38 extension table (escape-prefixed; each costs 2 GSM-7 character units).
const GSM_EXTENDED_CHARS = "^{}\\[~]|€";

const GSM_BASIC_SET = new Set(GSM_BASIC_CHARS);
const GSM_EXTENDED_SET = new Set(GSM_EXTENDED_CHARS);

const GSM_SINGLE_SEGMENT_LIMIT = 160;
const GSM_CONCAT_SEGMENT_LIMIT = 153;
const UCS2_SINGLE_SEGMENT_LIMIT = 70;
const UCS2_CONCAT_SEGMENT_LIMIT = 67;

export interface SmsSegmentEstimate {
  encoding: "GSM-7" | "UCS-2";
  characterCount: number;
  /** Only meaningful for GSM-7: basic-set chars cost 1 unit, extended-set chars cost 2. */
  gsmUnitCount: number | null;
  segmentCount: number;
}

/**
 * Estimates SMS encoding and segment count for a piece of text. Text using only the GSM 03.38
 * alphabet encodes as GSM-7 (160 chars/segment, 153/segment once concatenated across multiple
 * segments); any other character (emoji, most non-Latin scripts, smart quotes, etc.) forces the
 * whole message to UCS-2 (70 chars/segment, 67/segment concatenated) — a single non-GSM-7
 * character anywhere in the message affects the whole message's encoding, matching real carrier
 * behavior. This is guidance for an operator, not a guarantee of what a specific carrier bills.
 */
export function estimateSmsSegments(text: string): SmsSegmentEstimate {
  const characters = [...text];
  let isGsm7 = true;
  let gsmUnitCount = 0;

  for (const ch of characters) {
    if (GSM_BASIC_SET.has(ch)) {
      gsmUnitCount += 1;
    } else if (GSM_EXTENDED_SET.has(ch)) {
      gsmUnitCount += 2;
    } else {
      isGsm7 = false;
      break;
    }
  }

  if (isGsm7) {
    const segmentCount =
      gsmUnitCount <= GSM_SINGLE_SEGMENT_LIMIT ? (gsmUnitCount === 0 ? 0 : 1) : Math.ceil(gsmUnitCount / GSM_CONCAT_SEGMENT_LIMIT);
    return { encoding: "GSM-7", characterCount: characters.length, gsmUnitCount, segmentCount };
  }

  const segmentCount =
    characters.length <= UCS2_SINGLE_SEGMENT_LIMIT
      ? characters.length === 0
        ? 0
        : 1
      : Math.ceil(characters.length / UCS2_CONCAT_SEGMENT_LIMIT);
  return { encoding: "UCS-2", characterCount: characters.length, gsmUnitCount: null, segmentCount };
}
