import { useState } from "react";
import { previewImportBatch } from "./api";
import { CONTACT_IMPORT_FIELDS, type ColumnMapping, type ContactImportField, type PreviewResponse, type UploadResponse } from "./types";

interface ImportMappingStepProps {
  upload: UploadResponse;
  onMapped: (result: PreviewResponse) => void;
  onBack: () => void;
}

const UNMAPPED = "";

export default function ImportMappingStep({ upload, onMapped, onBack }: ImportMappingStepProps): JSX.Element {
  const [mapping, setMapping] = useState<Record<string, ContactImportField | typeof UNMAPPED>>(() => {
    const initial: Record<string, ContactImportField | typeof UNMAPPED> = {};
    for (const suggestion of upload.suggestedMapping) {
      initial[suggestion.header] = suggestion.suggested ?? UNMAPPED;
    }
    return initial;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const usedFields = new Set(Object.values(mapping).filter((v) => v !== UNMAPPED));
  const hasFirstAndLast = usedFields.has("firstName") && usedFields.has("lastName");

  async function handleContinue(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const columnMapping: ColumnMapping = {};
      for (const [header, field] of Object.entries(mapping)) {
        if (field !== UNMAPPED) columnMapping[header] = field;
      }
      const result = await previewImportBatch(upload.batch.id, columnMapping);
      onMapped(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to preview this mapping.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="import-mapping-step">
      <p className="cell-muted">
        {upload.batch.fileName} — {upload.batch.rowCount} row{upload.batch.rowCount === 1 ? "" : "s"} detected.
        Map each column to a Contact field, or leave it unmapped to ignore it.
      </p>

      <div className="table-wrap" style={{ marginTop: 16 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Source column</th>
              <th>Sample value</th>
              <th>Maps to</th>
            </tr>
          </thead>
          <tbody>
            {upload.batch.headers.map((header, i) => (
              <tr key={header}>
                <td className="cell-primary">{header}</td>
                <td className="cell-muted">{upload.sampleRows[0]?.[i] || "—"}</td>
                <td>
                  <select
                    className="select"
                    aria-label={`Map "${header}" to`}
                    value={mapping[header] ?? UNMAPPED}
                    onChange={(e) =>
                      setMapping((prev) => ({ ...prev, [header]: e.target.value as ContactImportField | typeof UNMAPPED }))
                    }
                  >
                    <option value={UNMAPPED}>— Not imported —</option>
                    {CONTACT_IMPORT_FIELDS.map((f) => (
                      <option key={f.field} value={f.field} disabled={usedFields.has(f.field) && mapping[header] !== f.field}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!hasFirstAndLast && (
        <p className="cell-muted" style={{ marginTop: 10 }}>
          First name and Last name must both be mapped before you can continue.
        </p>
      )}
      {error && (
        <p className="error-banner" role="alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}

      <div className="form-actions" style={{ marginTop: 16 }}>
        <button type="button" className="btn btn-secondary" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void handleContinue()} disabled={busy || !hasFirstAndLast}>
          {busy ? "Validating…" : "Continue to Preview"}
        </button>
      </div>
    </div>
  );
}
