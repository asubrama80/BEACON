import { useState } from "react";
import Modal from "../components/Modal";
import { createIncident } from "./api";
import type { Incident, IncidentSeverity } from "./types";
import { listUsers } from "../users/api";
import type { UserSummary } from "../users/types";
import { useAuth } from "../auth/useAuth";

interface CreateIncidentModalProps {
  onClose: () => void;
  onCreated: (incident: Incident) => void;
}

export default function CreateIncidentModal({ onClose, onCreated }: CreateIncidentModalProps): JSX.Element {
  const { user } = useAuth();
  const canAssignCommander = user?.permissions.includes("incidents.commander.assign") ?? false;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<IncidentSeverity>("warning");
  const [commanderSearch, setCommanderSearch] = useState("");
  const [commanderResults, setCommanderResults] = useState<UserSummary[]>([]);
  const [commander, setCommander] = useState<UserSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function searchCommanders(): Promise<void> {
    if (!commanderSearch.trim()) {
      setCommanderResults([]);
      return;
    }
    try {
      const response = await listUsers({ search: commanderSearch, status: "active" });
      setCommanderResults(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to search users.");
    }
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const incident = await createIncident({
        title,
        description: description || undefined,
        severity,
        commanderUserId: commander?.id,
      });
      onCreated(incident);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create this incident.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Create Incident" onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => void handleSubmit(e)}>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <label className="form-field">
          <span className="form-label">Incident title</span>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Potential Cybersecurity Incident"
            required
          />
        </label>
        <label className="form-field">
          <span className="form-label">Description</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label className="form-field">
          <span className="form-label">Severity</span>
          <select
            className="select"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as IncidentSeverity)}
          >
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </label>

        {canAssignCommander && (
          <div className="form-field">
            <span className="form-label">Incident Commander (optional)</span>
            {commander ? (
              <div className="filter-row" style={{ marginBottom: 0 }}>
                <span className="cell-primary">{commander.displayName}</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCommander(null)}>
                  Clear
                </button>
              </div>
            ) : (
              <>
                <div className="filter-row" style={{ marginBottom: 0 }}>
                  <div className="search-field">
                    <input
                      className="input"
                      placeholder="Search active BEACON users"
                      value={commanderSearch}
                      onChange={(e) => setCommanderSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void searchCommanders();
                        }
                      }}
                    />
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void searchCommanders()}>
                    Search
                  </button>
                </div>
                {commanderResults.length > 0 && (
                  <div className="table-wrap">
                    <table className="data-table">
                      <tbody>
                        {commanderResults.map((u) => (
                          <tr
                            key={u.id}
                            className="clickable"
                            onClick={() => {
                              setCommander(u);
                              setCommanderResults([]);
                              setCommanderSearch("");
                            }}
                          >
                            <td className="cell-primary">{u.displayName}</td>
                            <td className="cell-muted">{u.email}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
            <span className="form-hint">
              The commander must be an active, registered BEACON user. Assigning them here does not change their
              account roles or permissions.
            </span>
          </div>
        )}

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Creating…" : "Create Incident"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
