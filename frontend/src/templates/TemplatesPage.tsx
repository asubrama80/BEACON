import { useCallback, useEffect, useState } from "react";
import "./TemplatesPage.css";
import { listTemplates } from "./api";
import type { Template } from "./types";
import CreateTemplateModal from "./CreateTemplateModal";
import TemplateDetailModal from "./TemplateDetailModal";
import { useAuth } from "../auth/useAuth";

export default function TemplatesPage(): JSX.Element {
  const { user } = useAuth();
  const [items, setItems] = useState<Template[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [detailTemplateId, setDetailTemplateId] = useState<string | null>(null);

  const canCreate = user?.permissions.includes("templates.create") ?? false;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listTemplates({
        search: search || undefined,
        channel: channel || undefined,
        status: status || undefined,
      });
      setItems(response.items);
      setTotal(response.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load templates.");
    } finally {
      setLoading(false);
    }
  }, [search, channel, status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="templates-page">
      <h2 className="page-heading">Templates</h2>
      <p className="page-lede">Reusable message content for SMS and Email — ready to apply when composing an alert.</p>

      <div className="toolbar">
        <div className="filter-row" style={{ marginBottom: 0 }}>
          <div className="search-field">
            <input className="input" placeholder="Search templates by name" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">All Channels</option>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
          </select>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <div className="toolbar-actions">
          {canCreate && (
            <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
              Create Template
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="tpl-card-grid">
        {items.map((template) => (
          <div key={template.id} className="card tpl-tile">
            <div className="tpl-tile-head">
              <div className="tpl-tile-name">{template.name}</div>
            </div>
            <div className="tpl-tags">
              <span className="badge badge-neutral">{template.channel.toUpperCase()}</span>
              <span className={`badge ${template.status === "active" ? "badge-success" : "badge-warning"}`}>{template.status}</span>
            </div>
            {template.subject && (
              <div className="tpl-meta-row">
                <span>Subject</span>
                <span className="cell-primary">{template.subject}</span>
              </div>
            )}
            <div className="tpl-tile-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDetailTemplateId(template.id)}>
                View / Edit
              </button>
            </div>
          </div>
        ))}
      </div>

      {!loading && items.length === 0 && (
        <div className="card empty-state">
          <p>No templates found.</p>
        </div>
      )}

      <p className="cell-muted" style={{ marginTop: 10 }}>
        {total} template{total === 1 ? "" : "s"}
      </p>

      {showCreate && (
        <CreateTemplateModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void refresh();
          }}
        />
      )}

      {detailTemplateId && (
        <TemplateDetailModal
          templateId={detailTemplateId}
          onClose={() => {
            setDetailTemplateId(null);
            void refresh();
          }}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}
