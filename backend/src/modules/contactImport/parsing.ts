import { parse as parseCsvSync } from "csv-parse/sync";
import ExcelJS from "exceljs";
import { AuthError } from "../auth/errors.js";
import type { ContactImportConfig } from "./config.js";

export type ImportFileType = "csv" | "xlsx";

export interface ParsedSpreadsheet {
  /** Trimmed header cells, in file order. */
  headers: string[];
  /** Data rows (header row excluded), each an array of raw trimmed string cell values. */
  rows: string[][];
}

/** Detects the supported file type from a filename's extension only — never trusts a client-supplied MIME type alone. */
export function detectFileType(fileName: string): ImportFileType {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".xlsx")) return "xlsx";
  throw new AuthError(
    400,
    "import_file_invalid",
    "Unsupported file type. Only .csv and .xlsx files are supported.",
  );
}

function stringifyCellValue(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    // Formula cell: { formula, result }. Use only the cached/display result the file already
    // carries — the formula string itself is never evaluated. A formula that errored in the
    // source spreadsheet (result is an { error } object) is treated as empty rather than guessed.
    if ("result" in value) {
      const result = (value as { result?: unknown }).result;
      if (result === null || result === undefined || typeof result === "object") return "";
      return String(result);
    }
    // Rich text: { richText: [{ text }, ...] }.
    if ("richText" in value && Array.isArray((value as { richText: unknown }).richText)) {
      return (value as { richText: { text?: string }[] }).richText.map((part) => part.text ?? "").join("");
    }
    // Hyperlink: { text, hyperlink }. Never follow the link — display text only.
    if ("text" in value) {
      const text = (value as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    }
    return "";
  }
  return String(value);
}

function enforceBounds(headers: string[], rows: string[][], config: ContactImportConfig): void {
  if (headers.length === 0) {
    throw new AuthError(400, "import_file_invalid", "The file has no header row.");
  }
  if (headers.length > config.maxColumns) {
    throw new AuthError(
      400,
      "import_file_invalid",
      `The file has too many columns (max ${config.maxColumns}).`,
    );
  }
  const normalizedHeaders = new Set<string>();
  for (const header of headers) {
    const key = header.trim().toLowerCase();
    if (normalizedHeaders.has(key)) {
      throw new AuthError(400, "import_file_invalid", `Duplicate column header: "${header}".`);
    }
    normalizedHeaders.add(key);
  }
  if (rows.length === 0) {
    throw new AuthError(400, "import_file_invalid", "The file has a header row but no data rows.");
  }
  if (rows.length > config.maxRows) {
    throw new AuthError(400, "import_file_invalid", `The file has too many rows (max ${config.maxRows}).`);
  }
}

/**
 * Parses CSV using `csv-parse` — a pure text parser with no formula, macro, or external-reference
 * concept at all, so there is nothing in a CSV file that could be "executed."
 */
function parseCsv(buffer: Buffer): ParsedSpreadsheet {
  let records: string[][];
  try {
    records = parseCsvSync(buffer, {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      relax_column_count: true,
    }) as string[][];
  } catch {
    throw new AuthError(400, "import_file_invalid", "Unable to parse this file as CSV.");
  }

  const [headerRow, ...dataRows] = records;
  const headers = (headerRow ?? []).map((h) => h.trim());
  const rows = dataRows.map((row) => headers.map((_, i) => (row[i] ?? "").toString().trim()));
  return { headers, rows };
}

/**
 * Parses XLSX using `exceljs`, reading only the first worksheet's cell values. `Workbook.xlsx.load`
 * parses the OOXML zip/XML content in-memory and never executes macros (the xlsx format cannot
 * contain them — that requires the separate .xlsm format, which is not accepted), never fetches
 * external workbook references (exceljs performs no network I/O), and never evaluates formulas —
 * only their last cached result, already stored in the file, is read (see stringifyCellValue).
 */
async function parseXlsx(buffer: Buffer): Promise<ParsedSpreadsheet> {
  const workbook = new ExcelJS.Workbook();
  try {
    // exceljs's bundled type declarations predate the newer generic `Buffer<TArrayBuffer>` shape
    // in current @types/node; the runtime value is a plain Buffer either way.
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch {
    throw new AuthError(400, "import_file_invalid", "Unable to parse this file as XLSX.");
  }

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new AuthError(400, "import_file_invalid", "The workbook has no worksheets.");
  }

  const allRows: string[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      values.push(stringifyCellValue(cell.value).trim());
    });
    allRows.push(values);
  });

  const [headerRow, ...dataRows] = allRows;
  const headers = (headerRow ?? []).map((h) => h.trim());
  const rows = dataRows
    .map((row) => headers.map((_, i) => (row[i] ?? "").trim()))
    .filter((row) => row.some((cell) => cell.length > 0));

  return { headers, rows };
}

/** Parses an uploaded spreadsheet buffer, enforcing the configured row/column bounds. */
export async function parseSpreadsheet(
  buffer: Buffer,
  fileType: ImportFileType,
  config: ContactImportConfig,
): Promise<ParsedSpreadsheet> {
  const parsed = fileType === "csv" ? parseCsv(buffer) : await parseXlsx(buffer);
  enforceBounds(parsed.headers, parsed.rows, config);
  return parsed;
}
