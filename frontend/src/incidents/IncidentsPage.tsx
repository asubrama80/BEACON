import { useCallback, useEffect, useState } from "react";
import "./IncidentsPage.css";
import { listIncidents } from "./api";
import type { Incident } from "./types";
import CreateIncidentModal from "./CreateIncidentModal";
import IncidentDetailModal from "./IncidentDetailModal";
import { useAuth } from "../auth/useAuth";

const STATUS_BADGE: Record<string, string> = {
  open: "badge-neutral",
  active: "badge-critical",
  resolved: "badge-warning",
  closed: "badge-success",
};

const SEVERITY_BADGE: Record<string, string> = {
  info: "badge-neutral",
  warning: "badge-warning",
  high: "badge-critical",
  critical: "badge-critical",
};

interface IncidentsPageProps {
  /** Optional cross-page navigation hook — lets Command Center deep-link into the Alerts page. */
  onNavigateToAlerts?: (request: { alertId?: string; createIncidentId?: string }) => void;
}

export default function IncidentsPage({ onNavigateToAlerts }: IncidentsPageProps = {}): JSX.Element {
  const { user } = useAuth();
  const [items, setItems] = useState<Incident[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [severity, setSeverity] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);

  const canCreate = user?.permissions.includes("incidents.create") ?? false;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listIncidents({
        search: search || undefined,
        status: status || undefined,
        severity: severity || undefined,
        from: from ? new Date(from).toISOString() : undefined,
        to: to ? new Date(to).toISOString() : undefined,
      });
      setItems(response.items);
      setTotal(response.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load incidents.");
    } finally {
      setLoading(false);
    }
  }, [search, status, severity, from, to]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="incidents-page">
      <h2 className="page-heading">Incidents</h2>
      <p className="page-lede">Every emergency incident, its response team, and its operational timeline.</p>

      <div className="toolbar">
        <div className="filter-row" style={{ marginBottom: 0 }}>
          <div className="search-field">
            <input
              className="input"
              placeholder="Search by incident number or title"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="open">Open</option>
            <option value="active">Active</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          <select className="select" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">All Severities</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
          <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
          <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
        </div>
        <div className="toolbar-actions">
          {canCreate && (
            <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
              Create Incident
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Title</th>
                <th>Severity</th>
                <th>Status</th>
                <th>Commander</th>
                <th>Participants</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.map((incident) => (
                <tr key={incident.id} className="clickable" onClick={() => setSelectedIncidentId(incident.id)}>
                  <td className="cell-muted incident-number">{incident.incidentNumber}</td>
                  <td className="cell-primary">{incident.title}</td>
                  <td>
                    <span className={`badge ${SEVERITY_BADGE[incident.severity] ?? "badge-neutral"}`}>{incident.severity}</span>
                  </td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[incident.status] ?? "badge-neutral"}`}>{incident.status}</span>
                  </td>
                  <td className="cell-muted">{incident.commander?.displayName ?? "Unassigned"}</td>
                  <td className="cell-muted">{incident.participantCount}</td>
                  <td className="cell-muted">{new Date(incident.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && items.length === 0 && (
            <div className="empty-state">
              <p>No incidents found.</p>
            </div>
          )}
        </div>
      </div>

      <p className="cell-muted" style={{ marginTop: 10 }}>
        {total} incident{total === 1 ? "" : "s"}
      </p>

      {showCreate && (
        <CreateIncidentModal
          onClose={() => setShowCreate(false)}
          onCreated={(incident) => {
            setShowCreate(false);
            void refresh();
            setSelectedIncidentId(incident.id);
          }}
        />
      )}

      {selectedIncidentId && (
        <IncidentDetailModal
          incidentId={selectedIncidentId}
          onClose={() => {
            setSelectedIncidentId(null);
            void refresh();
          }}
          onChanged={() => void refresh()}
          onNavigateToAlerts={onNavigateToAlerts}
        />
      )}
    </div>
  );
}
