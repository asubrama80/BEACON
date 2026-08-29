import { useEffect, useState } from "react";
import { getImportBatch } from "./api";
import type { ImportBatch, ImportRow, ImportRowStatus } from "./types";

interface ImportPreviewStepProps {
  batch: ImportBatch;
  initialRows: ImportRow[];
  initialTotal: number;
  decisions: Map<string, { selected: boolean; confirmDuplicate: boolean }>;
  onDecisionsChange: (decisions: Map<string, { selected: boolean; confirmDuplicate: boolean }>) => void;
  onContinue: () => void;
  onBack: () => void;
}

const PAGE_SIZE = 25;

const STATUS_LABEL: Record<ImportRowStatus, string> = {
  valid: "Valid",
  invalid: "Invalid",
  possible_duplicate: "Possible duplicate",
  duplicate_in_file: "Duplicate in file",
};

const STATUS_BADGE_CLASS: Record<ImportRowStatus, string> = {
  valid: "badge-success",
  invalid: "badge-critical",
  possible_duplicate: "badge-warning",
  duplicate_in_file: "badge-warning",
};

export default function ImportPreviewStep({
  batch,
  initialRows,
  initialTotal,
  decisions,
  onDecisionsChange,
  onContinue,
  onBack,
}: ImportPreviewStepProps): JSX.Element {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<ImportRow[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Seed decisions for any row not already tracked (first load, and any newly-fetched page).
    const next = new Map(decisions);
    let changed = false;
    for (const row of rows) {
      if (!next.has(row.id)) {
        next.set(row.id, { selected: row.selected, confirmDuplicate: false });
        changed = true;
      }
    }
    if (changed) onDecisionsChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  async function loadPage(nextPage: number): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const result = await getImportBatch(batch.id, { page: nextPage, pageSize: PAGE_SIZE });
      setRows(result.rows);
      setTotal(result.total);
      setPage(nextPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load this page.");
    } finally {
      setLoading(false);
    }
  }

  function setDecision(rowId: string, patch: Partial<{ selected: boolean; confirmDuplicate: boolean }>): void {
    const next = new Map(decisions);
    const current = next.get(rowId) ?? { selected: false, confirmDuplicate: false };
    next.set(rowId, { ...current, ...patch });
    onDecisionsChange(next);
  }

  const summary = batch.summary;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selectedCount = [...decisions.values()].filter((d) => d.selected).length;

  return (
    <div className="import-preview-step">
      {summary && (
        <div className="import-stats">
          <div className="import-stat">
            <div className="n">{summary.total}</div>
            <div className="l">Rows Detected</div>
          </div>
          <div className="import-stat">
            <div className="n">{summary.valid}</div>
            <div className="l">Valid</div>
          </div>
          <div className="import-stat">
            <div className="n">{summary.invalid}</div>
            <div className="l">Invalid</div>
          </div>
          <div className="import-stat">
            <div className="n">{summary.possibleDuplicate}</div>
            <div className="l">Possible Duplicates</div>
          </div>
          <div className="import-stat">
            <div className="n">{summary.duplicateInFile}</div>
            <div className="l">Duplicate In File</div>
          </div>
          <div className="import-stat">
            <div className="n">{selectedCount}</div>
            <div className="l">Selected</div>
          </div>
        </div>
      )}

      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Import</th>
              <th>Row</th>
              <th>Name</th>
              <th>Email</th>
              <th>Mobile</th>
              <th>Status</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const decision = decisions.get(row.id) ?? { selected: row.selected, confirmDuplicate: false };
              const requiresApproval = row.status === "possible_duplicate" || row.status === "duplicate_in_file";
              return (
                <tr key={row.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Import row ${row.rowIndex}`}
                      checked={row.status !== "invalid" && decision.selected}
                      disabled={row.status === "invalid"}
                      onChange={(e) =>
                        setDecision(row.id, {
                          selected: e.target.checked,
                          confirmDuplicate: requiresApproval ? e.target.checked : decision.confirmDuplicate,
                        })
                      }
                    />
                  </td>
                  <td className="cell-muted">{row.rowIndex}</td>
                  <td className="cell-primary">{`${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || "—"}</td>
                  <td className="cell-muted">{row.email ?? "—"}</td>
                  <td className="cell-muted">{row.mobilePhone ?? "—"}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE_CLASS[row.status]}`}>{STATUS_LABEL[row.status]}</span>
                  </td>
                  <td className="cell-muted" style={{ fontSize: 12 }}>
                    {row.reasons.join("; ")}
                    {row.duplicateMatches && row.duplicateMatches.length > 0 && (
                      <div>Matches: {row.duplicateMatches.map((m) => m.displayName).join(", ")}</div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="empty-state">
            <p>No rows on this page.</p>
          </div>
        )}
      </div>

      {totalPages > 1 && (
        <div className="toolbar" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1 || loading} onClick={() => void loadPage(page - 1)}>
            Previous
          </button>
          <span className="cell-muted">
            Page {page} of {totalPages}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={page >= totalPages || loading} onClick={() => void loadPage(page + 1)}>
            Next
          </button>
        </div>
      )}

      <div className="form-actions" style={{ marginTop: 16 }}>
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          Back
        </button>
        <button type="button" className="btn btn-primary" onClick={onContinue} disabled={selectedCount === 0}>
          Continue ({selectedCount} selected)
        </button>
      </div>
    </div>
  );
}
