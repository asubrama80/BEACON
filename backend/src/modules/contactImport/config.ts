export interface ContactImportConfig {
  /** Maximum accepted upload size, in bytes. */
  maxFileSizeBytes: number;
  /** Maximum data rows (excluding the header row) a single import may contain. */
  maxRows: number;
  /** Maximum columns (headers) a single import may contain. */
  maxColumns: number;
  /** How long an unconfirmed batch remains usable before it's treated as expired. */
  batchTtlMinutes: number;
}

export function loadContactImportConfig(source: NodeJS.ProcessEnv = process.env): ContactImportConfig {
  return {
    maxFileSizeBytes: Number(source.CONTACT_IMPORT_MAX_FILE_SIZE_BYTES ?? 5 * 1024 * 1024),
    maxRows: Number(source.CONTACT_IMPORT_MAX_ROWS ?? 2000),
    maxColumns: Number(source.CONTACT_IMPORT_MAX_COLUMNS ?? 40),
    batchTtlMinutes: Number(source.CONTACT_IMPORT_BATCH_TTL_MINUTES ?? 30),
  };
}
