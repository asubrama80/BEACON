import { useRef, useState } from "react";
import { uploadImportFile } from "./api";
import type { UploadResponse } from "./types";

interface ImportUploadStepProps {
  onUploaded: (result: UploadResponse) => void;
}

export default function ImportUploadStep({ onUploaded }: ImportUploadStepProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await uploadImportFile(file);
      onUploaded(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to upload this file.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="import-upload-step">
      <div className="dropzone" onClick={() => inputRef.current?.click()}>
        <div className="dropzone-title">{busy ? "Uploading…" : "Choose a CSV or XLSX file"}</div>
        <p className="cell-muted" style={{ marginTop: 6 }}>
          Bring contacts in from a spreadsheet export. Nothing is created until you review and confirm.
        </p>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          style={{ marginTop: 12 }}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            inputRef.current?.click();
          }}
        >
          Browse File
        </button>
        <p className="cell-muted" style={{ marginTop: 10, fontSize: 12 }}>
          .csv or .xlsx only
        </p>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.xlsx"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void handleFile(file);
        }}
      />
      {error && (
        <p className="error-banner" role="alert" style={{ marginTop: 16 }}>
          {error}
        </p>
      )}
    </div>
  );
}
