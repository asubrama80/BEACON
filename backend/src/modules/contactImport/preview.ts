import type { Database } from "@beacon/database";
import { AuthError } from "../auth/errors.js";
import { validateName, normalizeChannelFields } from "../contacts/service.js";
import { findLikelyDuplicates } from "../contacts/contactQueries.js";
import type { DuplicateMatchDto } from "../contacts/dto.js";
import type { ContactImportField } from "./mapping.js";
import type { ImportRowInsert } from "./batchQueries.js";
import type { ImportRowStatus } from "./dto.js";

function extractRow(
  headers: string[],
  rawRow: string[],
  mapping: Record<string, ContactImportField>,
): Record<ContactImportField, string> {
  const byField: Record<ContactImportField, string> = {
    firstName: "",
    lastName: "",
    email: "",
    mobilePhone: "",
    department: "",
    referenceId: "",
  };
  headers.forEach((header, i) => {
    const destination = mapping[header];
    if (destination) {
      byField[destination] = (rawRow[i] ?? "").trim();
    }
  });
  return byField;
}

/**
 * Computes the full validated/normalized/duplicate-checked preview for every row of a batch,
 * reusing Module 04's own `validateName`/`normalizeChannelFields` (identical validation and
 * normalization rules, not a reimplementation) and `findLikelyDuplicates` (identical database
 * duplicate detection). Never touches the database except to read for duplicate matches — no
 * Contact is created here.
 */
export async function buildPreviewRows(
  db: Database,
  batchId: string,
  headers: string[],
  rawRows: string[][],
  mapping: Record<string, ContactImportField>,
): Promise<ImportRowInsert[]> {
  const seenEmail = new Map<string, number>();
  const seenPhone = new Map<string, number>();
  const results: ImportRowInsert[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const rowIndex = i + 1;
    const extracted = extractRow(headers, rawRows[i] ?? [], mapping);

    const reasons: string[] = [];
    let status: ImportRowStatus = "valid";
    let firstName: string | null = null;
    let lastName: string | null = null;
    let normalizedEmail: string | undefined;
    let normalizedPhone: string | undefined;
    let department: string | null = null;
    let referenceId: string | null = null;

    try {
      firstName = validateName(extracted.firstName, "First name");
      lastName = validateName(extracted.lastName, "Last name");
      const normalized = normalizeChannelFields({
        email: extracted.email || undefined,
        mobilePhone: extracted.mobilePhone || undefined,
        department: extracted.department || undefined,
        referenceId: extracted.referenceId || undefined,
      });
      normalizedEmail = normalized.email || undefined;
      normalizedPhone = normalized.mobilePhone || undefined;
      department = normalized.department || null;
      referenceId = normalized.referenceId || null;
    } catch (error) {
      if (!(error instanceof AuthError)) throw error;
      status = "invalid";
      reasons.push(error.message);
    }

    let duplicateMatches: DuplicateMatchDto[] | null = null;

    if (status !== "invalid") {
      let inFile = false;

      if (normalizedEmail) {
        const firstSeenAt = seenEmail.get(normalizedEmail);
        if (firstSeenAt !== undefined) {
          inFile = true;
          reasons.push(`Duplicate normalized email — also seen at row ${firstSeenAt}.`);
        } else {
          seenEmail.set(normalizedEmail, rowIndex);
        }
      }
      if (normalizedPhone) {
        const firstSeenAt = seenPhone.get(normalizedPhone);
        if (firstSeenAt !== undefined) {
          inFile = true;
          reasons.push(`Duplicate normalized mobile phone — also seen at row ${firstSeenAt}.`);
        } else {
          seenPhone.set(normalizedPhone, rowIndex);
        }
      }

      if (inFile) {
        status = "duplicate_in_file";
      } else {
        const candidates = await findLikelyDuplicates(
          db,
          { email: normalizedEmail, mobilePhone: normalizedPhone },
          undefined,
        );
        if (candidates.length > 0) {
          status = "possible_duplicate";
          duplicateMatches = candidates.map((c) => ({
            id: c.id,
            displayName: `${c.firstName} ${c.lastName}`.trim(),
            matchedOn: c.matchedOn,
          }));
          reasons.push("Matches an existing contact by normalized email or mobile phone.");
        }
      }
    }

    results.push({
      batchId,
      rowIndex,
      firstName,
      lastName,
      email: normalizedEmail ?? null,
      mobilePhone: normalizedPhone ?? null,
      department,
      referenceId,
      status,
      reasons,
      duplicateMatches,
      selected: status === "valid",
    });
  }

  return results;
}
