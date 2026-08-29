import { pgTable, uuid, varchar, integer, boolean, jsonb, timestamp, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users.js";

/**
 * A short-lived, operator-owned bulk Contact import session (Module 05). Holds the parsed
 * spreadsheet as text values only (never the original binary file) and the operator's confirmed
 * column mapping, bounded by the parsing module's row/column caps. `rawRows`/`columnMapping` are
 * purged (set to null) once the batch completes or expires — see contactImport/batchQueries.ts.
 */
export const contactImportBatches = pgTable(
  "contact_import_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    fileType: varchar("file_type", { length: 8 }).notNull(),
    status: varchar("status", { length: 32 }).notNull().default("mapping"),
    /** Detected spreadsheet headers, trimmed, in original file order. */
    headers: jsonb("headers").notNull(),
    /** Parsed data rows as arrays of raw text cell values, aligned to `headers`. Nulled on purge. */
    rawRows: jsonb("raw_rows"),
    /** Operator-confirmed { sourceHeader: destinationField } map, set once preview runs. */
    columnMapping: jsonb("column_mapping"),
    rowCount: integer("row_count").notNull(),
    /** Computed row-status counts and confirm results — see contactImport/service.ts. */
    summary: jsonb("summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [
    index("contact_import_batches_created_by_idx").on(table.createdBy),
    index("contact_import_batches_status_idx").on(table.status),
    check(
      "contact_import_batches_file_type_check",
      sql`${table.fileType} IN ('csv', 'xlsx')`,
    ),
    check(
      "contact_import_batches_status_check",
      sql`${table.status} IN ('mapping', 'previewed', 'confirmed', 'completed', 'failed', 'expired')`,
    ),
  ],
);

/**
 * One row of a batch's computed preview (post validation/normalization/duplicate-detection).
 * This is the server-held source of truth the confirm step acts on — the client only ever sends
 * back row ids and selected/approve flags, never contact field values (see Module 05 prompt doc,
 * "Preview/confirm separation"). PII columns are purged (set to null) after confirm completes or
 * the batch expires, leaving only the non-PII status/result fields for the results view.
 */
export const contactImportRows = pgTable(
  "contact_import_rows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => contactImportBatches.id, { onDelete: "cascade" }),
    /** 1-based data-row position in the source file (excluding the header row), for operator display. */
    rowIndex: integer("row_index").notNull(),
    firstName: varchar("first_name", { length: 128 }),
    lastName: varchar("last_name", { length: 128 }),
    email: varchar("email", { length: 255 }),
    mobilePhone: varchar("mobile_phone", { length: 32 }),
    department: varchar("department", { length: 128 }),
    referenceId: varchar("reference_id", { length: 64 }),
    status: varchar("status", { length: 32 }).notNull(),
    /** Safe, human-readable reason strings only — never raw field values. */
    reasons: jsonb("reasons").notNull().default([]),
    /** DuplicateMatchDto[] shape reused from Module 04 — id/displayName/matchedOn only. */
    duplicateMatches: jsonb("duplicate_matches"),
    selected: boolean("selected").notNull().default(false),
    importedContactId: uuid("imported_contact_id"),
    importResult: varchar("import_result", { length: 16 }),
    importError: varchar("import_error", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("contact_import_rows_batch_id_idx").on(table.batchId),
    index("contact_import_rows_batch_status_idx").on(table.batchId, table.status),
    check(
      "contact_import_rows_status_check",
      sql`${table.status} IN ('valid', 'invalid', 'possible_duplicate', 'duplicate_in_file')`,
    ),
    check(
      "contact_import_rows_import_result_check",
      sql`${table.importResult} IN ('imported', 'skipped', 'failed')`,
    ),
  ],
);
