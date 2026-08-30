import { useEffect, useRef, useState } from "react";
import Modal from "../components/Modal";
import TemplatePreviewModal from "./TemplatePreviewModal";
import { disableTemplate, enableTemplate, getTemplate, updateTemplate } from "./api";
import { PLACEHOLDER_PICKER } from "./placeholders";
import type { TemplateDetail } from "./types";
import { useAuth } from "../auth/useAuth";

interface TemplateDetailModalProps {
  templateId: string;
  onClose: () => void;
  onChanged: (template: TemplateDetail) => void;
}

export default function TemplateDetailModal({ templateId, onClose, onChanged }: TemplateDetailModalProps): JSX.Element {
  const { user } = useAuth();
  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const canUpdate = user?.permissions.includes("templates.update") ?? false;
  const canDisable = user?.permissions.includes("templates.disable") ?? false;

  async function refresh(): Promise<void> {
    const fresh = await getTemplate(templateId);
    setTemplate(fresh);
    setName(fresh.name);
    setSubject(fresh.subject ?? "");
    setBody(fresh.body);
    onChanged(fresh);
  }

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load template."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  function insertPlaceholder(token: string): void {
    const el = bodyRef.current;
    if (!el) {
      setBody((prev) => prev + token);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + token.length;
    });
  }

  async function saveDetails(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await updateTemplate(templateId, template?.channel === "email" ? { name, subject, body } : { name, body });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update template.");
    } finally {
      setBusy(false);
    }
  }

  if (!template) {
    return (
      <Modal title="Template" onClose={onClose}>
        {error ? (
          <p className="error-banner" role="alert">
            {error}
          </p>
        ) : (
          <p>Loading…</p>
        )}
      </Modal>
    );
  }

  return (
    <Modal title={template.name} onClose={onClose}>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="detail-section">
        <div className="detail-section-title">Status</div>
        <span className={`badge ${template.status === "active" ? "badge-success" : "badge-warning"}`}>{template.status}</span>
        <span className="badge badge-neutral" style={{ marginLeft: 8 }}>
          {template.channel.toUpperCase()}
        </span>
      </div>

      <div className="detail-section">
        <div className="detail-section-title">Details</div>
        <div className="form-grid">
          <label className="form-field">
            <span className="form-label">Template name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!canUpdate} />
          </label>

          {template.channel === "email" && (
            <label className="form-field">
              <span className="form-label">Subject</span>
              <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!canUpdate} />
            </label>
          )}

          {canUpdate && (
            <div className="form-field">
              <span className="form-label">Placeholders</span>
              <div className="toolbar-actions">
                {PLACEHOLDER_PICKER.map((p) => (
                  <button key={p.key} type="button" className="btn btn-secondary btn-sm" onClick={() => insertPlaceholder(p.token)}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <label className="form-field">
            <span className="form-label">Message body</span>
            <textarea
              ref={bodyRef}
              className="input"
              style={{ height: 120, paddingTop: 8 }}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={!canUpdate}
            />
          </label>
          <span className="form-hint">
            {body.length} character{body.length === 1 ? "" : "s"}
          </span>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowPreview(true)}>
              Preview
            </button>
            {canUpdate && (
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void saveDetails()}>
                Save details
              </button>
            )}
          </div>
        </div>
      </div>

      {canDisable && (
        <div className="detail-section">
          <div className="detail-actions">
            {template.status === "active" ? (
              confirmingDisable ? (
                <>
                  <span className="cell-muted">Disable this template?</span>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={() =>
                      void (async () => {
                        setBusy(true);
                        try {
                          await disableTemplate(templateId);
                          setConfirmingDisable(false);
                          await refresh();
                        } finally {
                          setBusy(false);
                        }
                      })()
                    }
                  >
                    Confirm disable
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingDisable(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmingDisable(true)}>
                  Disable template
                </button>
              )
            ) : (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    setBusy(true);
                    try {
                      await enableTemplate(templateId);
                      await refresh();
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                Re-enable template
              </button>
            )}
          </div>
        </div>
      )}

      {showPreview && <TemplatePreviewModal input={{ templateId }} onClose={() => setShowPreview(false)} />}
    </Modal>
  );
}
