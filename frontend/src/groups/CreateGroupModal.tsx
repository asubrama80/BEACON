import { useState } from "react";
import Modal from "../components/Modal";
import { createGroup } from "./api";
import type { Group } from "./types";

interface CreateGroupModalProps {
  onClose: () => void;
  onCreated: (group: Group) => void;
}

export default function CreateGroupModal({ onClose, onCreated }: CreateGroupModalProps): JSX.Element {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const group = await createGroup({ name, description: description || undefined });
      onCreated(group);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create this group.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Create Group" onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => void handleSubmit(e)}>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        <label className="form-field">
          <span className="form-label">Group name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="form-field">
          <span className="form-label">Description</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Create Group"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
