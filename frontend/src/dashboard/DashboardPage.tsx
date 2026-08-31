import { useCallback, useEffect, useState } from "react";
import { getDashboard } from "./api";
import type { DashboardData } from "./types";

const INCIDENT_STATUS_BADGE: Record<string, string> = {
  open: "badge-neutral",
  active: "badge-critical",
  resolved: "badge-warning",
  closed: "badge-success",
};

const ALERT_STATUS_BADGE: Record<string, string> = {
  draft: "badge-neutral",
  ready: "badge-success",
  cancelled: "badge-warning",
  dispatching: "badge-neutral",
  submitted: "badge-success",
  partially_submitted: "badge-warning",
  submission_failed: "badge-critical",
};

interface DashboardPageProps {
  onNavigateToIncidents?: () => void;
  onNavigateToAlerts?: (request: { alertId?: string }) => void;
}

/**
 * A bounded aggregate over existing authoritative data (Modules 04/06/08/09/10/11) — never a
 * parallel status model of its own. See claude/prompts/21-dashboard-history.md, "Dashboard
 * architecture".
 */
export default function DashboardPage({ onNavigateToIncidents, onNavigateToAlerts }: DashboardPageProps): JSX.Element {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setData(await getDashboard());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the dashboard.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error) {
    return (
      <p className="error-banner" role="alert">
        {error}
      </p>
    );
  }
  if (!data) {
    return <p>Loading…</p>;
  }

  const { incidents, alerts, contacts, groups, attention } = data;
  const hasAttention = attention.readyAlertsNotDispatched > 0 || attention.deliveryFailures > 0;

  return (
    <div className="dashboard-page">
      <h2 className="page-heading">Emergency Communication</h2>
      <p className="page-lede">Send critical communications even when normal corporate systems are unavailable.</p>

      <div className="metric-grid">
        <div className="card metric-card">
          <div className="metric-label">Active Contacts</div>
          <div className="metric-value mono">{contacts.active}</div>
        </div>
        <div className="card metric-card">
          <div className="metric-label">Active Groups</div>
          <div className="metric-value mono">{groups.active}</div>
        </div>
        <div className="card metric-card">
          <div className="metric-label">Active Incidents</div>
          <div className={`metric-value mono ${incidents.active > 0 ? "accent-warn" : ""}`}>{incidents.active}</div>
          <div className="metric-foot">{incidents.open} open · {incidents.resolved} resolved</div>
        </div>
        <div className="card metric-card">
          <div className="metric-label">Delivery Failures</div>
          <div className={`metric-value mono ${attention.deliveryFailures > 0 ? "accent-warn" : "accent-success"}`}>
            {attention.deliveryFailures}
          </div>
          <div className="metric-foot">{alerts.delivery.delivered} delivered · {alerts.delivery.deliveryPending} pending</div>
        </div>
      </div>

      {hasAttention && (
        <div className="attention-card">
          <div className="attention-card-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.3 4.2 2.6 18a1.8 1.8 0 0 0 1.6 2.7h15.6a1.8 1.8 0 0 0 1.6-2.7L13.7 4.2a1.8 1.8 0 0 0-3.4 0Z" />
            </svg>
          </div>
          <div>
            <div className="attention-card-title">Attention Required</div>
            <ul>
              {attention.readyAlertsNotDispatched > 0 && (
                <li>
                  {attention.readyAlertsNotDispatched} alert{attention.readyAlertsNotDispatched === 1 ? "" : "s"} ready but not yet dispatched
                </li>
              )}
              {attention.deliveryFailures > 0 && (
                <li>{attention.deliveryFailures} delivery failure{attention.deliveryFailures === 1 ? "" : "s"} across recent alerts</li>
              )}
            </ul>
          </div>
        </div>
      )}

      <div className="card section-block">
        <div className="card-pad">
          <div className="flex-between" style={{ marginBottom: 16 }}>
            <div>
              <div className="section-heading">Recent Incidents</div>
              <div className="section-sub">The most recently updated incidents.</div>
            </div>
            {onNavigateToIncidents && (
              <button type="button" className="link-btn" onClick={onNavigateToIncidents}>
                View all incidents →
              </button>
            )}
          </div>
          {incidents.recent.length === 0 ? (
            <div className="empty-state">
              <p>No incidents yet.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Title</th>
                    <th>Severity</th>
                    <th>Status</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {incidents.recent.map((incident) => (
                    <tr key={incident.id}>
                      <td className="cell-muted mono">{incident.incidentNumber}</td>
                      <td className="cell-primary">{incident.title}</td>
                      <td>
                        <span className="badge badge-neutral">{incident.severity}</span>
                      </td>
                      <td>
                        <span className={`badge ${INCIDENT_STATUS_BADGE[incident.status] ?? "badge-neutral"}`}>{incident.status}</span>
                      </td>
                      <td className="cell-muted">{new Date(incident.updatedAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="card section-block">
        <div className="card-pad">
          <div className="flex-between" style={{ marginBottom: 16 }}>
            <div>
              <div className="section-heading">Recent Alerts</div>
              <div className="section-sub">Select an alert to view its delivery summary.</div>
            </div>
            {onNavigateToAlerts && (
              <button type="button" className="link-btn" onClick={() => onNavigateToAlerts({})}>
                View all history →
              </button>
            )}
          </div>
          {alerts.recent.length === 0 ? (
            <div className="empty-state">
              <p>No alerts have been sent yet.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Alert</th>
                    <th>Channel</th>
                    <th>Status</th>
                    <th className="num-right">Delivered</th>
                    <th className="num-right">Pending</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.recent.map((alert) => (
                    <tr
                      key={alert.id}
                      className={onNavigateToAlerts ? "clickable" : ""}
                      onClick={() => onNavigateToAlerts?.({ alertId: alert.id })}
                    >
                      <td className="cell-primary">{alert.title}</td>
                      <td className="cell-muted">{alert.channel.toUpperCase()}</td>
                      <td>
                        <span className={`badge ${ALERT_STATUS_BADGE[alert.status] ?? "badge-neutral"}`}>{alert.status}</span>
                      </td>
                      <td className="num-right mono">{alert.deliverySummary.delivered}</td>
                      <td className="num-right mono">{alert.deliverySummary.deliveryPending}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
