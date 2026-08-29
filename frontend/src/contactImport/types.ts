export type ContactImportField = "firstName" | "lastName" | "email" | "mobilePhone" | "department" | "referenceId";

export const CONTACT_IMPORT_FIELDS: { field: ContactImportField; label: string }[] = [
  { field: "firstName", label: "First name" },
  { field: "lastName", label: "Last name" },
  { field: "email", label: "Email" },
  { field: "mobilePhone", label: "Mobile phone" },
  { field: "department", label: "Department" },
  { field: "referenceId", label: "Employee / Reference ID" },
];

export type ColumnMapping = Record<string, ContactImportField>;

export interface MappingSuggestion {
  header: string;
  suggested: ContactImportField | null;
}

export type ImportRowStatus = "valid" | "invalid" | "possible_duplicate" | "duplicate_in_file";
export type ImportRowResult = "imported" | "skipped" | "failed";

export interface DuplicateMatch {
  id: string;
  displayName: string;
  matchedOn: ("email" | "mobilePhone")[];
}

export interface ImportRow {
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
  duplicateMatches: DuplicateMatch[] | null;
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

export interface ImportBatch {
  id: string;
  fileName: string;
  fileType: "csv" | "xlsx";
  status: string;
  rowCount: number;
  headers: string[];
  columnMapping: ColumnMapping | null;
  summary: ImportSummary | null;
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
}

export interface UploadResponse {
  batch: ImportBatch;
  sampleRows: string[][];
  suggestedMapping: MappingSuggestion[];
}

export interface PreviewResponse {
  batch: ImportBatch;
  rows: ImportRow[];
  total: number;
}

export interface RowDecision {
  rowId: string;
  selected: boolean;
  confirmDuplicate?: boolean;
}

export interface ConfirmRowResult {
  rowId: string;
  rowIndex: number;
  displayName: string;
  status: ImportRowStatus;
  importResult: ImportRowResult;
  contactId?: string;
  error?: string;
}

export interface ConfirmResponse {
  summary: ImportSummary;
  results: ConfirmRowResult[];
}
