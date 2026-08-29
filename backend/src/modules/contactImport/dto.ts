import type { DuplicateMatchDto } from "../contacts/dto.js";
import type { ContactImportField } from "./mapping.js";

export type ImportRowStatus = "valid" | "invalid" | "possible_duplicate" | "duplicate_in_file";
export type ImportRowResult = "imported" | "skipped" | "failed";

/** A single row's computed preview state, server-held — the client never supplies this shape. */
export interface ImportRowDto {
  id: string;
  rowIndex: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  mobilePhone: string | null;
  department: string | null;
  referenceId: string | null;
  status: ImportRowStatus;
  reasons: string[];
  duplicateMatches: DuplicateMatchDto[] | null;
  selected: boolean;
  importResult: ImportRowResult | null;
  importError: string | null;
}

export interface ImportSummary {
  total: number;
  valid: number;
  invalid: number;
  possibleDuplicate: number;
  duplicateInFile: number;
  selected: number;
  imported: number;
  skipped: number;
  failed: number;
}

export interface ImportBatchDto {
  id: string;
  fileName: string;
  fileType: "csv" | "xlsx";
  status: string;
  rowCount: number;
  headers: string[];
  columnMapping: Record<string, ContactImportField> | null;
  summary: ImportSummary | null;
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
}

export function emptySummary(total: number): ImportSummary {
  return {
    total,
    valid: 0,
    invalid: 0,
    possibleDuplicate: 0,
    duplicateInFile: 0,
    selected: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
  };
}
