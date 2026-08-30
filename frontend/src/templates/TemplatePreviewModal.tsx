import { useEffect, useState } from "react";
import Modal from "../components/Modal";
import { previewTemplate } from "./api";
import type { PreviewResponse } from "./types";

interface TemplatePreviewModalProps {
  input: { templateId: string } | { channel: "sms" | "email"; subject?: string; body: string };
  onClose: () => void;
}

export default function TemplatePreviewModal({ input, onClose }: TemplatePreviewModalProps): JSX.Element {
  const [result, setResult] = useState<PreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    previewTemplate(input)
      .then(setResult)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to render preview."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Modal title="Template Preview" onClose={onClose}>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {!result && !error && <p>Loading…</p>}
      {result && (
        <div className="detail-section">
          <p className="cell-muted">Rendered with synthetic sample values — no real Contact data is used.</p>

          {result.renderedSubject !== undefined && (
            <div className="form-field">
              <span className="form-label">Subject</span>
              <div className="template-preview-box">{result.renderedSubject}</div>
            </div>
          )}

          <div className="form-field">
            <span className="form-label">Body</span>
            {/* React always escapes text content — combined with CSS white-space:pre-wrap this
                safely preserves line breaks without dangerouslySetInnerHTML or manual <br/>
                insertion; an XSS-shaped payload (e.g. "<script>") renders as inert literal text. */}
            <div className="template-preview-box">{result.renderedBody}</div>
          </div>

          {result.sms && (
            <p className="cell-muted">
              {result.sms.encoding} · {result.sms.characterCount} character{result.sms.characterCount === 1 ? "" : "s"} ·{" "}
              {result.sms.segmentCount} segment{result.sms.segmentCount === 1 ? "" : "s"} (estimate)
            </p>
          )}

          {result.unresolvedPlaceholders.length > 0 && (
            <p className="warning-banner">Unresolved placeholders: {result.unresolvedPlaceholders.join(", ")}</p>
          )}
        </div>
      )}
    </Modal>
  );
}
