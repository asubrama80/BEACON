import { useState } from "react";
import { confirmImportBatch } from "./api";
import { decisionsToPayload } from "./decisions";
import type { ConfirmResponse, ImportBatch } from "./types";

interface ImportConfirmStepProps {
  batch: ImportBatch;
  decisions: Map<string, { selected: boolean; confirmDuplicate: boolean }>;
  onConfirmed: (result: ConfirmResponse) => void;
  onBack: () => void;
}

export default function ImportConfirmStep({ batch, decisions, onConfirmed, onBack }: ImportConfirmStepProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = [...decisions.values()].filter((d) => d.selected);
  const approvedDuplicates = selected.filter((d) => d.confirmDuplicate).length;

  async function handleConfirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await confirmImportBatch(batch.id, decisionsToPayload(decisions));
      onConfirmed(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to complete this import.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="import-confirm-step">
      <div className="card">
        <p>
          You are about to import <strong>{selected.length}</strong> contact{selected.length === 1 ? "" : "s"} from{" "}
          <strong>{batch.fileName}</strong>.
        </p>
        {approvedDuplicates > 0 && (
          <p className="cell-muted">
            {approvedDuplicates} of these {approvedDuplicates === 1 ? "is" : "are"} a flagged duplicate you explicitly
            chose to import anyway — each will be created as a separate Contact, never merged into an existing one.
          </p>
        )}
        <p className="cell-muted">This action cannot be undone from this wizard. Review your selections before continuing.</p>
      </div>

      {error && (
        <p className="error-banner" role="alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}

      <div className="form-actions" style={{ marginTop: 16 }}>
        <button type="button" className="btn btn-secondary" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void handleConfirm()} disabled={busy || selected.length === 0}>
          {busy ? "Importing…" : `Import ${selected.length} Contact${selected.length === 1 ? "" : "s"}`}
        </button>
      </div>
    </div>
  );
}
