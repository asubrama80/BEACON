import { useCallback, useEffect, useState } from "react";
import { searchAudit } from "./api";
import type { AuditEvent, AuditFilters } from "./types";

const ACTOR_LABEL: Record<string, string> = {
  user: "User",
  guest: "Guest",
  contact: "Contact",
  system: "System",
};

function formatMetadata(metadata: Record<string, unknown>): string {
  const entries = Object.entries(metadata);
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(", ");
}

/**
 * Platform-wide Audit — who did what, to which resource, when. Deliberately not the Incident
 * timeline (a different, per-Incident operational record). See claude/prompts/20-audit.md,
 * "Frontend".
 */
export default function AuditPage(): JSX.Element {
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [eventType, setEventType] = useState("");
  const [actorType, setActorType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filters: AuditFilters = {
    eventType: eventType || undefined,
    actorType: actorType || undefined,
    from: from ? new Date(from).toISOString() : undefined,
    to: to ? new Date(to).toISOString() : undefined,
  };

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await searchAudit(filters);
      setItems(response.items);
      setNextCursor(response.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load audit events.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventType, actorType, from, to]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await searchAudit(filters, nextCursor);
      setItems((current) => [...current, ...response.items]);
      setNextCursor(response.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load more audit events.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="audit-page">
      <h2 className="page-heading">Audit</h2>
      <p className="page-lede">A record of who did what, and when — for accountability during and after an incident.</p>

      <div className="toolbar">
        <div className="filter-row" style={{ marginBottom: 0 }}>
          <div className="search-field">
            <input
              className="input"
              placeholder="Filter by event type (e.g. INCIDENT_CREATED)"
              value={eventType}
              onChange={(e) => setEventType(e.target.value)}
            />
          </div>
          <select className="select" value={actorType} onChange={(e) => setActorType(e.target.value)}>
            <option value="">All Actor Types</option>
            <option value="user">User</option>
            <option value="guest">Guest</option>
            <option value="system">System</option>
          </select>
          <input className="input" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
          <input className="input" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
        </div>
      </div>

      {error && (
        <p className="error-banner" role="alert" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date/Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Resource</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {items.map((event) => (
                <tr key={event.id}>
                  <td className="cell-muted mono">{new Date(event.timestamp).toLocaleString()}</td>
                  <td className="cell-primary">
                    {event.actor.displayName ?? "Unknown"}
                    <span className="badge badge-neutral" style={{ marginLeft: 6, fontSize: 10 }}>
                      {ACTOR_LABEL[event.actor.type] ?? event.actor.type}
                    </span>
                  </td>
                  <td>
                    <span className="badge badge-neutral">{event.eventType}</span>
                  </td>
                  <td className="cell-muted">
                    {event.resource.type ?? "—"}
                    {event.resource.id ? ` (${event.resource.id.slice(0, 8)}…)` : ""}
                  </td>
                  <td className="cell-muted">{formatMetadata(event.metadata)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && items.length === 0 && (
            <div className="empty-state">
              <p>No audit activity recorded yet.</p>
            </div>
          )}
        </div>
      </div>

      {nextCursor && (
        <div className="form-actions" style={{ justifyContent: "center", marginTop: 12 }}>
          <button type="button" className="btn btn-secondary btn-sm" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}

      <p className="section-sub" style={{ marginTop: 14 }}>
        Audit records are retained for accountability and cannot be deleted from this application.
      </p>
    </div>
  );
}
