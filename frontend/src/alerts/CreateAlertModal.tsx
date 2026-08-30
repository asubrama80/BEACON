import { useState } from "react";
import Modal from "../components/Modal";
import { createAlert } from "./api";
import type { AlertDetail } from "./types";
import { listIncidents } from "../incidents/api";
import type { Incident } from "../incidents/types";
import { listTemplates } from "../templates/api";
import type { Template } from "../templates/types";

interface CreateAlertModalProps {
  onClose: () => void;
  onCreated: (alert: AlertDetail) => void;
}

export default function CreateAlertModal({ onClose, onCreated }: CreateAlertModalProps): JSX.Element {
  const [title, setTitle] = useState("");
  const [channel, setChannel] = useState<"sms" | "email">("sms");
  const [contentSource, setContentSource] = useState<"template" | "adhoc">("adhoc");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  const [incidentSearch, setIncidentSearch] = useState("");
  const [incidentResults, setIncidentResults] = useState<Incident[]>([]);
  const [incident, setIncident] = useState<Incident | null>(null);

  const [templateSearch, setTemplateSearch] = useState("");
  const [templateResults, setTemplateResults] = useState<Template[]>([]);
  const [template, setTemplate] = useState<Template | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function searchIncidents(): Promise<void> {
    if (!incidentSearch.trim()) {
      setIncidentResults([]);
      return;
    }
    try {
      const response = await listIncidents({ search: incidentSearch });
      setIncidentResults(response.items.filter((i) => i.status !== "closed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to search incidents.");
    }
  }

  async function searchTemplates(): Promise<void> {
    try {
      const response = await listTemplates({ search: templateSearch || undefined, channel, status: "active" });
      setTemplateResults(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to search templates.");
    }
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const alert = await createAlert({
        title,
        channel,
        contentSource,
        incidentId: incident?.id,
        templateId: contentSource === "template" ? template?.id : undefined,
        subject: contentSource === "adhoc" ? subject || undefined : undefined,
        body: contentSource === "adhoc" ? body || undefined : undefined,
      });
      onCreated(alert);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create this alert.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Create Alert" onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => void handleSubmit(e)}>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}

        <label className="form-field">
          <span className="form-label">Alert title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>

        <label className="form-field">
          <span className="form-label">Channel</span>
          <select className="select" value={channel} onChange={(e) => setChannel(e.target.value as "sms" | "email")}>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
          </select>
        </label>

        <div className="form-field">
          <span className="form-label">Incident (optional)</span>
          {incident ? (
            <div className="filter-row" style={{ marginBottom: 0 }}>
              <span className="cell-primary">{incident.incidentNumber} — {incident.title}</span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setIncident(null)}>
                Clear
              </button>
            </div>
          ) : (
            <>
              <div className="filter-row" style={{ marginBottom: 0 }}>
                <div className="search-field">
                  <input
                    className="input"
                    placeholder="Search open Incidents (leave blank for standalone)"
                    value={incidentSearch}
                    onChange={(e) => setIncidentSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void searchIncidents();
                      }
                    }}
                  />
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void searchIncidents()}>
                  Search
                </button>
              </div>
              {incidentResults.length > 0 && (
                <div className="table-wrap">
                  <table className="data-table">
                    <tbody>
                      {incidentResults.map((i) => (
                        <tr
                          key={i.id}
                          className="clickable"
                          onClick={() => {
                            setIncident(i);
                            setIncidentResults([]);
                            setIncidentSearch("");
                          }}
                        >
                          <td className="cell-muted">{i.incidentNumber}</td>
                          <td className="cell-primary">{i.title}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        <div className="form-field">
          <span className="form-label">Content source</span>
          <div className="checkbox-row">
            <label>
              <input
                type="radio"
                name="contentSource"
                checked={contentSource === "adhoc"}
                onChange={() => setContentSource("adhoc")}
              />{" "}
              Ad-hoc message
            </label>
          </div>
          <div className="checkbox-row">
            <label>
              <input
                type="radio"
                name="contentSource"
                checked={contentSource === "template"}
                onChange={() => setContentSource("template")}
              />{" "}
              From Template
            </label>
          </div>
        </div>

        {contentSource === "template" ? (
          <div className="form-field">
            <span className="form-label">Template</span>
            {template ? (
              <div className="filter-row" style={{ marginBottom: 0 }}>
                <span className="cell-primary">{template.name}</span>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTemplate(null)}>
                  Clear
                </button>
              </div>
            ) : (
              <>
                <div className="filter-row" style={{ marginBottom: 0 }}>
                  <div className="search-field">
                    <input
                      className="input"
                      placeholder={`Search active ${channel.toUpperCase()} templates`}
                      value={templateSearch}
                      onChange={(e) => setTemplateSearch(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void searchTemplates();
                        }
                      }}
                    />
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => void searchTemplates()}>
                    Search
                  </button>
                </div>
                {templateResults.length > 0 && (
                  <div className="table-wrap">
                    <table className="data-table">
                      <tbody>
                        {templateResults.map((t) => (
                          <tr
                            key={t.id}
                            className="clickable"
                            onClick={() => {
                              setTemplate(t);
                              setTemplateResults([]);
                              setTemplateSearch("");
                            }}
                          >
                            <td className="cell-primary">{t.name}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            {channel === "email" && (
              <label className="form-field">
                <span className="form-label">Subject</span>
                <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
              </label>
            )}
            <label className="form-field">
              <span className="form-label">Message body</span>
              <textarea
                className="input"
                style={{ height: 90, paddingTop: 8 }}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Hello {{firstName}}, ..."
              />
            </label>
            <span className="form-hint">Audience and final review happen after creation, before Ready.</span>
          </>
        )}

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Creating…" : "Create Alert"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
