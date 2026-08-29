import type { Database } from "@beacon/database";
import { AuthError, NOT_AUTHORIZED } from "../auth/errors.js";
import { recordAuthEvent } from "../auth/audit.js";
import { createContact } from "../contacts/service.js";
import type { ContactImportConfig } from "./config.js";
import { detectFileType, parseSpreadsheet, type ImportFileType } from "./parsing.js";
import { suggestMapping, validateMapping, type ColumnMapping, type MappingSuggestion } from "./mapping.js";
import {
  createBatch,
  findBatchById,
  setBatchMappingPreviewed,
  claimBatchForConfirm,
  markBatchCompleted,
  markBatchFailed,
  markBatchExpired,
  purgeBatchPii,
  replaceRows,
  listRows,
  listAllRows,
  setRowImportResult,
  type BatchRow,
} from "./batchQueries.js";
import { buildPreviewRows } from "./preview.js";
import { emptySummary, type ImportBatchDto, type ImportRowDto, type ImportSummary } from "./dto.js";

const SAMPLE_ROW_COUNT = 5;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function normalizePagination(page?: number, pageSize?: number): { page: number; pageSize: number } {
  const normalizedPage = Number.isInteger(page) && page! > 0 ? page! : 1;
  const normalizedPageSize =
    Number.isInteger(pageSize) && pageSize! > 0 ? Math.min(pageSize!, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  return { page: normalizedPage, pageSize: normalizedPageSize };
}

function toBatchDto(batch: BatchRow): ImportBatchDto {
  return {
    id: batch.id,
    fileName: batch.fileName,
    fileType: batch.fileType,
    status: batch.status,
    rowCount: batch.rowCount,
    headers: batch.headers,
    columnMapping: batch.columnMapping,
    summary: batch.summary,
    createdAt: batch.createdAt.toISOString(),
    expiresAt: batch.expiresAt.toISOString(),
    confirmedAt: batch.confirmedAt ? batch.confirmedAt.toISOString() : null,
  };
}

function toRowDto(row: {
  id: string;
  rowIndex: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  mobilePhone: string | null;
  department: string | null;
  referenceId: string | null;
  status: ImportRowDto["status"];
  reasons: string[];
  duplicateMatches: ImportRowDto["duplicateMatches"];
  selected: boolean;
  importResult: ImportRowDto["importResult"];
  importError: string | null;
}): ImportRowDto {
  return {
    id: row.id,
    rowIndex: row.rowIndex,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    mobilePhone: row.mobilePhone,
    department: row.department,
    referenceId: row.referenceId,
    status: row.status,
    reasons: row.reasons,
    duplicateMatches: row.duplicateMatches,
    selected: row.selected,
    importResult: row.importResult,
    importError: row.importError,
  };
}

/** Loads a batch, enforcing per-operator ownership and lazily expiring it if its TTL has passed. */
async function loadOwnedBatch(db: Database, actorId: string, batchId: string): Promise<BatchRow> {
  const batch = await findBatchById(db, batchId);
  if (!batch) {
    throw new AuthError(404, "not_found", "Import batch not found.");
  }
  // Ownership is enforced for every operator, with no role-based bypass — a batch is only ever
  // visible to the operator who created it, regardless of what else their role can otherwise see.
  if (batch.createdBy !== actorId) {
    throw NOT_AUTHORIZED;
  }

  const terminal = batch.status === "completed" || batch.status === "failed" || batch.status === "expired";
  if (!terminal && new Date() > batch.expiresAt) {
    await purgeBatchPii(db, batchId);
    await markBatchExpired(db, batchId);
    throw new AuthError(410, "import_batch_expired", "This import batch has expired. Upload the file again.");
  }

  return batch;
}

export interface UploadResult {
  batch: ImportBatchDto;
  sampleRows: string[][];
  suggestedMapping: MappingSuggestion[];
}

export async function uploadFile(
  db: Database,
  config: ContactImportConfig,
  actorId: string,
  fileName: string,
  buffer: Buffer,
): Promise<UploadResult> {
  const safeFileName = fileName.replace(/[/\\]/g, "_").slice(-255);
  const fileType: ImportFileType = detectFileType(safeFileName);

  if (buffer.byteLength > config.maxFileSizeBytes) {
    throw new AuthError(
      400,
      "import_file_invalid",
      `File is too large (max ${Math.floor(config.maxFileSizeBytes / (1024 * 1024))} MB).`,
    );
  }

  const parsed = await parseSpreadsheet(buffer, fileType, config);
  const expiresAt = new Date(Date.now() + config.batchTtlMinutes * 60 * 1000);

  const batch = await createBatch(db, {
    createdBy: actorId,
    fileName: safeFileName,
    fileType,
    headers: parsed.headers,
    rawRows: parsed.rows,
    rowCount: parsed.rows.length,
    expiresAt,
  });

  return {
    batch: toBatchDto(batch),
    sampleRows: parsed.rows.slice(0, SAMPLE_ROW_COUNT),
    suggestedMapping: suggestMapping(parsed.headers),
  };
}

export interface PreviewResult {
  batch: ImportBatchDto;
  rows: ImportRowDto[];
  total: number;
}

export async function previewBatch(
  db: Database,
  actorId: string,
  batchId: string,
  mapping: ColumnMapping,
): Promise<PreviewResult> {
  const batch = await loadOwnedBatch(db, actorId, batchId);

  if (batch.status === "confirmed" || batch.status === "completed") {
    throw new AuthError(409, "import_batch_not_previewable", "This batch has already been confirmed.");
  }
  if (!batch.rawRows) {
    throw new AuthError(409, "import_batch_not_previewable", "This batch's data is no longer available.");
  }

  validateMapping(mapping, batch.headers);

  const computedRows = await buildPreviewRows(db, batchId, batch.headers, batch.rawRows, mapping);
  const summary = summarizeRows(computedRows);

  await replaceRows(db, batchId, computedRows);
  await setBatchMappingPreviewed(db, batchId, mapping, summary);

  await recordAuthEvent(db, {
    eventType: "CONTACT_IMPORT_PREVIEWED",
    actorId,
    resourceType: "contact_import_batch",
    resourceId: batchId,
    metadata: {
      fileType: batch.fileType,
      total: summary.total,
      valid: summary.valid,
      invalid: summary.invalid,
      possibleDuplicate: summary.possibleDuplicate,
      duplicateInFile: summary.duplicateInFile,
    },
  });

  const refreshed = await loadOwnedBatch(db, actorId, batchId);
  const page = await listRows(db, batchId, { page: 1, pageSize: DEFAULT_PAGE_SIZE });
  return { batch: toBatchDto(refreshed), rows: page.items.map(toRowDto), total: page.total };
}

function summarizeRows(
  rows: { status: "valid" | "invalid" | "possible_duplicate" | "duplicate_in_file"; selected: boolean }[],
): ImportSummary {
  const summary = emptySummary(rows.length);
  for (const row of rows) {
    if (row.status === "valid") summary.valid += 1;
    else if (row.status === "invalid") summary.invalid += 1;
    else if (row.status === "possible_duplicate") summary.possibleDuplicate += 1;
    else summary.duplicateInFile += 1;
    if (row.selected) summary.selected += 1;
  }
  return summary;
}

export interface GetBatchOptions {
  page?: number | undefined;
  pageSize?: number | undefined;
  status?: "valid" | "invalid" | "possible_duplicate" | "duplicate_in_file" | undefined;
}

export async function getBatch(
  db: Database,
  actorId: string,
  batchId: string,
  options: GetBatchOptions,
): Promise<PreviewResult> {
  const batch = await loadOwnedBatch(db, actorId, batchId);
  const { page, pageSize } = normalizePagination(options.page, options.pageSize);
  const result = await listRows(db, batchId, { page, pageSize, status: options.status });
  return { batch: toBatchDto(batch), rows: result.items.map(toRowDto), total: result.total };
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
  status: string;
  importResult: "imported" | "skipped" | "failed";
  contactId?: string;
  error?: string;
}

export interface ConfirmResult {
  summary: ImportSummary;
  results: ConfirmRowResult[];
}

export async function confirmBatch(
  db: Database,
  actorId: string,
  batchId: string,
  decisions: RowDecision[],
): Promise<ConfirmResult> {
  const batch = await loadOwnedBatch(db, actorId, batchId);

  if (batch.status !== "previewed") {
    throw new AuthError(
      409,
      "import_batch_not_previewable",
      "This batch has already been confirmed, or hasn't been previewed yet.",
    );
  }

  const claimed = await claimBatchForConfirm(db, batchId);
  if (!claimed) {
    throw new AuthError(
      409,
      "import_batch_not_previewable",
      "This batch has already been confirmed, or hasn't been previewed yet.",
    );
  }

  const decisionByRowId = new Map(decisions.map((d) => [d.rowId, d]));
  const rows = await listAllRows(db, batchId);
  const summary = batch.summary ? { ...batch.summary } : emptySummary(rows.length);
  summary.imported = 0;
  summary.skipped = 0;
  summary.failed = 0;
  const results: ConfirmRowResult[] = [];

  try {
    for (const row of rows) {
      const decision = decisionByRowId.get(row.id);
      const effectiveSelected = decision ? decision.selected : row.selected;
      const effectiveConfirmDuplicate = decision?.confirmDuplicate ?? false;
      const displayName = `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim();

      const requiresDuplicateApproval = row.status === "possible_duplicate" || row.status === "duplicate_in_file";
      const canImport =
        row.status !== "invalid" &&
        effectiveSelected &&
        (!requiresDuplicateApproval || effectiveConfirmDuplicate);

      if (!canImport) {
        await setRowImportResult(db, row.id, { importResult: "skipped" });
        summary.skipped += 1;
        results.push({ rowId: row.id, rowIndex: row.rowIndex, displayName, status: row.status, importResult: "skipped" });
        continue;
      }

      try {
        const createInput: Parameters<typeof createContact>[1] = {
          firstName: row.firstName ?? "",
          lastName: row.lastName ?? "",
          confirmDuplicate: true,
        };
        if (row.referenceId) createInput.referenceId = row.referenceId;
        if (row.email) createInput.email = row.email;
        if (row.mobilePhone) createInput.mobilePhone = row.mobilePhone;
        if (row.department) createInput.department = row.department;

        const contact = await createContact(db, createInput, actorId);
        await setRowImportResult(db, row.id, { importResult: "imported", importedContactId: contact.id });
        summary.imported += 1;
        results.push({
          rowId: row.id,
          rowIndex: row.rowIndex,
          displayName,
          status: row.status,
          importResult: "imported",
          contactId: contact.id,
        });
      } catch (error) {
        const message = error instanceof AuthError ? error.message : "This row could not be imported.";
        await setRowImportResult(db, row.id, { importResult: "failed", importError: message });
        summary.failed += 1;
        results.push({
          rowId: row.id,
          rowIndex: row.rowIndex,
          displayName,
          status: row.status,
          importResult: "failed",
          error: message,
        });
      }
    }

    await markBatchCompleted(db, batchId, summary);
    await purgeBatchPii(db, batchId);

    await recordAuthEvent(db, {
      eventType: "CONTACT_IMPORT_COMPLETED",
      actorId,
      resourceType: "contact_import_batch",
      resourceId: batchId,
      metadata: {
        fileType: batch.fileType,
        total: summary.total,
        imported: summary.imported,
        skipped: summary.skipped,
        failed: summary.failed,
      },
    });

    return { summary, results };
  } catch (error) {
    await markBatchFailed(db, batchId);
    await purgeBatchPii(db, batchId);
    await recordAuthEvent(db, {
      eventType: "CONTACT_IMPORT_FAILED",
      actorId,
      resourceType: "contact_import_batch",
      resourceId: batchId,
      metadata: { fileType: batch.fileType },
    });
    throw error;
  }
}
