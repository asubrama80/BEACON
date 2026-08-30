import { useRef, useState } from "react";
import Modal from "../components/Modal";
import TemplatePreviewModal from "./TemplatePreviewModal";
import { createTemplate } from "./api";
import { PLACEHOLDER_PICKER } from "./placeholders";
import type { TemplateChannel, TemplateDetail } from "./types";

interface CreateTemplateModalProps {
  onClose: () => void;
  onCreated: (template: TemplateDetail) => void;
}

export default function CreateTemplateModal({ onClose, onCreated }: CreateTemplateModalProps): JSX.Element {
  const [channel, setChannel] = useState<TemplateChannel>("sms");
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  function insertPlaceholder(token: string): void {
    const el = bodyRef.current;
    if (!el) {
      setBody((prev) => prev + token);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + token + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + token.length;
    });
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const template = await createTemplate({
        name,
        channel,
        body,
        ...(channel === "email" ? { subject } : {}),
      });
      onCreated(template);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create this template.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Create Template" onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => void handleSubmit(e)}>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}

        <label className="form-field">
          <span className="form-label">Template name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>

        <label className="form-field">
          <span className="form-label">Channel</span>
          <select className="select" value={channel} onChange={(e) => setChannel(e.target.value as TemplateChannel)}>
            <option value="sms">SMS</option>
            <option value="email">Email</option>
          </select>
        </label>

        {channel === "email" && (
          <label className="form-field">
            <span className="form-label">Subject</span>
            <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} required />
          </label>
        )}

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

        <label className="form-field">
          <span className="form-label">Message body</span>
          <textarea
            ref={bodyRef}
            className="input"
            style={{ height: 120, paddingTop: 8 }}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
          />
        </label>
        <span className="form-hint">
          {body.length} character{body.length === 1 ? "" : "s"}
          {channel === "sms" && " — use Preview for an exact segment estimate."}
        </span>

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setShowPreview(true)} disabled={!body.trim()}>
            Preview
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save Template"}
          </button>
        </div>
      </form>

      {showPreview && (
        <TemplatePreviewModal
          input={channel === "email" ? { channel, subject, body } : { channel, body }}
          onClose={() => setShowPreview(false)}
        />
      )}
    </Modal>
  );
}
