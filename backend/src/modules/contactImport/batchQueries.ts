import { and, eq, sql } from "drizzle-orm";
import { contactImportBatches, contactImportRows, type Database } from "@beacon/database";
import type { DuplicateMatchDto } from "../contacts/dto.js";
import type { ContactImportField } from "./mapping.js";
import type { ImportRowResult, ImportRowStatus, ImportSummary } from "./dto.js";

export interface BatchRow {
  id: string;
  createdBy: string;
  fileName: string;
  fileType: "csv" | "xlsx";
  status: string;
  headers: string[];
  rawRows: string[][] | null;
  columnMapping: Record<string, ContactImportField> | null;
  rowCount: number;
  summary: ImportSummary | null;
  createdAt: Date;
  expiresAt: Date;
  confirmedAt: Date | null;
}

export interface CreateBatchInput {
  createdBy: string;
  fileName: string;
  fileType: "csv" | "xlsx";
  headers: string[];
  rawRows: string[][];
  rowCount: number;
  expiresAt: Date;
}

export async function createBatch(db: Database, input: CreateBatchInput): Promise<BatchRow> {
  const [row] = await db
    .insert(contactImportBatches)
    .values({
      createdBy: input.createdBy,
      fileName: input.fileName,
      fileType: input.fileType,
      headers: input.headers,
      rawRows: input.rawRows,
      rowCount: input.rowCount,
      expiresAt: input.expiresAt,
    })
    .returning();
  return row as unknown as BatchRow;
}

export async function findBatchById(db: Database, id: string): Promise<BatchRow | undefined> {
  const [row] = await db.select().from(contactImportBatches).where(eq(contactImportBatches.id, id)).limit(1);
  return row as unknown as BatchRow | undefined;
}

export async function setBatchMappingPreviewed(
  db: Database,
  id: string,
  mapping: Record<string, ContactImportField>,
  summary: ImportSummary,
): Promise<void> {
  await db
    .update(contactImportBatches)
    .set({ columnMapping: mapping, status: "previewed", summary })
    .where(eq(contactImportBatches.id, id));
}

/**
 * Atomically transitions a batch from `previewed` to `confirmed` — the `WHERE status = 'previewed'`
 * clause makes double-confirm and confirm-replay structurally impossible: a second, concurrent, or
 * retried confirm request always finds zero rows affected and gets a clear rejection rather than
 * running the import logic twice.
 */
export async function claimBatchForConfirm(db: Database, id: string): Promise<boolean> {
  const result = await db
    .update(contactImportBatches)
    .set({ status: "confirmed", confirmedAt: new Date() })
    .where(and(eq(contactImportBatches.id, id), eq(contactImportBatches.status, "previewed")))
    .returning({ id: contactImportBatches.id });
  return result.length === 1;
}

export async function markBatchCompleted(db: Database, id: string, summary: ImportSummary): Promise<void> {
  await db.update(contactImportBatches).set({ status: "completed", summary }).where(eq(contactImportBatches.id, id));
}

export async function markBatchFailed(db: Database, id: string): Promise<void> {
  await db.update(contactImportBatches).set({ status: "failed" }).where(eq(contactImportBatches.id, id));
}

export async function markBatchExpired(db: Database, id: string): Promise<void> {
  await db.update(contactImportBatches).set({ status: "expired" }).where(eq(contactImportBatches.id, id));
}

/** Purges raw uploaded text and per-row Contact PII once a batch no longer needs them (completed/expired). */
export async function purgeBatchPii(db: Database, id: string): Promise<void> {
  await db.update(contactImportBatches).set({ rawRows: null }).where(eq(contactImportBatches.id, id));
  await db
    .update(contactImportRows)
    .set({
      firstName: null,
      lastName: null,
      email: null,
      mobilePhone: null,
      department: null,
      referenceId: null,
      duplicateMatches: null,
    })
    .where(eq(contactImportRows.batchId, id));
}

export interface ImportRowInsert {
  batchId: string;
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
}

/** Replaces any previously computed preview rows for a batch — supports re-preview after a mapping change. */
export async function replaceRows(db: Database, batchId: string, rows: ImportRowInsert[]): Promise<void> {
  await db.delete(contactImportRows).where(eq(contactImportRows.batchId, batchId));
  if (rows.length === 0) return;
  await db.insert(contactImportRows).values(rows);
}

export interface StoredImportRow {
  id: string;
  batchId: string;
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
  importedContactId: string | null;
  importResult: ImportRowResult | null;
  importError: string | null;
}

export interface ListRowsFilter {
  status?: ImportRowStatus | undefined;
  page: number;
  pageSize: number;
}

export async function listRows(
  db: Database,
  batchId: string,
  filter: ListRowsFilter,
): Promise<{ items: StoredImportRow[]; total: number }> {
  const whereClause = filter.status
    ? and(eq(contactImportRows.batchId, batchId), eq(contactImportRows.status, filter.status))
    : eq(contactImportRows.batchId, batchId);

  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(contactImportRows).where(whereClause);

  const items = await db
    .select()
    .from(contactImportRows)
    .where(whereClause)
    .orderBy(contactImportRows.rowIndex)
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);

  return { items: items as unknown as StoredImportRow[], total: countRow?.count ?? 0 };
}

/** Loads every row for a batch, unpaginated — used internally by confirm, never returned directly to a client. */
export async function listAllRows(db: Database, batchId: string): Promise<StoredImportRow[]> {
  const items = await db
    .select()
    .from(contactImportRows)
    .where(eq(contactImportRows.batchId, batchId))
    .orderBy(contactImportRows.rowIndex);
  return items as unknown as StoredImportRow[];
}

export async function setRowImportResult(
  db: Database,
  rowId: string,
  result: { importResult: ImportRowResult; importedContactId?: string; importError?: string },
): Promise<void> {
  await db
    .update(contactImportRows)
    .set({
      importResult: result.importResult,
      importedContactId: result.importedContactId,
      importError: result.importError,
    })
    .where(eq(contactImportRows.id, rowId));
}
