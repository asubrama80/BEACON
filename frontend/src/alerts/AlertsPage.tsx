import { useCallback, useEffect, useState } from "react";
import "./AlertsPage.css";
import { listAlerts } from "./api";
import type { AlertSummary } from "./types";
import CreateAlertModal from "./CreateAlertModal";
import AlertDetailModal from "./AlertDetailModal";
import { useAuth } from "../auth/useAuth";

const STATUS_BADGE: Record<string, string> = {
  draft: "badge-neutral",
  ready: "badge-success",
  cancelled: "badge-warning",
  dispatching: "badge-neutral",
  submitted: "badge-success",
  partially_submitted: "badge-warning",
  submission_failed: "badge-critical",
};

const STATUS_LABEL: Record<string, string> = {
  partially_submitted: "partially submitted",
  submission_failed: "submission failed",
};

export default function AlertsPage(): JSX.Element {
  const { user } = useAuth();
  const [items, setItems] = useState<AlertSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [channel, setChannel] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);

  const canCreate = user?.permissions.includes("alerts.create") ?? false;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listAlerts({
        search: search || undefined,
        status: status || undefined,
        channel: channel || undefined,
      });
      setItems(response.items);
      setTotal(response.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load alerts.");
    } finally {
      setLoading(false);
    }
  }, [search, status, channel]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="alerts-page">
      <h2 className="page-heading">Alerts</h2>
      <p className="page-lede">
        Emergency communication plans — prepared, reviewed, and dispatched to the notification provider here.
        Delivery tracking (what happens after the provider accepts a message) is shown on each alert once it has
        been submitted.
      </p>

      <div className="toolbar">
        <div className="filter-row" style={{ marginBottom: 0 }}>
          <div className="search-field">
            <input
              className="input"
              placeholder="Search by alert number or title"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="draft">Draft</option>
            <option value="ready">Ready</option>
            <option value="dispatching">Dispatching</option>
            <option value="submitted">Submitted</option>
            <option value="partially_submitted">Partially Submitted</option>
            <option value="submission_failed">Submission Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <select className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">All Channels</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
          </select>
        </div>
        <div className="toolbar-actions">
          {canCreate && (
            <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
              Create Alert
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
                <th>Incident</th>
                <th>Channel</th>
                <th>Status</th>
                <th>Eligible</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.map((alert) => (
                <tr key={alert.id} className="clickable" onClick={() => setSelectedAlertId(alert.id)}>
                  <td className="cell-muted alert-number">{alert.alertNumber}</td>
                  <td className="cell-primary">{alert.title}</td>
                  <td className="cell-muted">{alert.incident ? alert.incident.incidentNumber : "Standalone"}</td>
                  <td className="cell-muted">{alert.channel.toUpperCase()}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[alert.status] ?? "badge-neutral"}`}>
                      {STATUS_LABEL[alert.status] ?? alert.status}
                    </span>
                  </td>
                  <td className="cell-muted">{alert.eligibleRecipientCount ?? "—"}</td>
                  <td className="cell-muted">{new Date(alert.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && items.length === 0 && (
            <div className="empty-state">
              <p>No alerts found.</p>
            </div>
          )}
        </div>
      </div>

      <p className="cell-muted" style={{ marginTop: 10 }}>
        {total} alert{total === 1 ? "" : "s"}
      </p>

      {showCreate && (
        <CreateAlertModal
          onClose={() => setShowCreate(false)}
          onCreated={(alert) => {
            setShowCreate(false);
            void refresh();
            setSelectedAlertId(alert.id);
          }}
        />
      )}

      {selectedAlertId && (
        <AlertDetailModal
          alertId={selectedAlertId}
          onClose={() => {
            setSelectedAlertId(null);
            void refresh();
          }}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}
