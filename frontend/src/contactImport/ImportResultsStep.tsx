import type { ConfirmResponse } from "./types";

interface ImportResultsStepProps {
  result: ConfirmResponse;
  onDone: () => void;
}

export default function ImportResultsStep({ result, onDone }: ImportResultsStepProps): JSX.Element {
  const { summary, results } = result;

  return (
    <div className="import-results-step">
      <div className="import-stats">
        <div className="import-stat">
          <div className="n">{summary.total}</div>
          <div className="l">Rows Detected</div>
        </div>
        <div className="import-stat">
          <div className="n">{summary.imported}</div>
          <div className="l">Imported</div>
        </div>
        <div className="import-stat">
          <div className="n">{summary.skipped}</div>
          <div className="l">Skipped</div>
        </div>
        <div className="import-stat">
          <div className="n">{summary.failed}</div>
          <div className="l">Failed</div>
        </div>
      </div>

      <div className="table-wrap" style={{ marginTop: 16 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Row</th>
              <th>Name</th>
              <th>Result</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {results.map((row) => (
              <tr key={row.rowId}>
                <td className="cell-muted">{row.rowIndex}</td>
                <td className="cell-primary">{row.displayName || "—"}</td>
                <td>
                  <span
                    className={`badge ${
                      row.importResult === "imported"
                        ? "badge-success"
                        : row.importResult === "failed"
                          ? "badge-critical"
                          : "badge-neutral"
                    }`}
                  >
                    {row.importResult}
                  </span>
                </td>
                <td className="cell-muted" style={{ fontSize: 12 }}>
                  {row.error ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="form-actions" style={{ marginTop: 16 }}>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
