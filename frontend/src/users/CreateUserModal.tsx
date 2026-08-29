import { useEffect, useState, type FormEvent } from "react";
import Modal from "../components/Modal";
import { createUser, listRoles } from "./api";
import type { RoleRef, UserDetail } from "./types";

interface CreateUserModalProps {
  onClose: () => void;
  onCreated: (user: UserDetail) => void;
}

export default function CreateUserModal({ onClose, onCreated }: CreateUserModalProps): JSX.Element {
  const [roles, setRoles] = useState<RoleRef[]>([]);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [initialPassword, setInitialPassword] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    listRoles()
      .then(setRoles)
      .catch(() => setRoles([]));
  }, []);

  function toggleRole(code: string): void {
    setSelectedRoles((current) => (current.includes(code) ? current.filter((c) => c !== code) : [...current, code]));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const user = await createUser({ email, displayName, initialPassword, roleCodes: selectedRoles });
      onCreated(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create user.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="New user" onClose={onClose}>
      <form className="form-grid" onSubmit={(event) => void handleSubmit(event)}>
        <label className="form-field">
          <span className="form-label">Email</span>
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoFocus
          />
        </label>
        <label className="form-field">
          <span className="form-label">Display name</span>
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
        </label>
        <label className="form-field">
          <span className="form-label">Initial password</span>
          <input
            className="input"
            type="password"
            value={initialPassword}
            onChange={(e) => setInitialPassword(e.target.value)}
            required
          />
        </label>
        <span className="form-hint">Share this with the user securely — it is not emailed automatically.</span>

        <div className="form-field">
          <span className="form-label">Roles</span>
          {roles.map((role) => (
            <label key={role.id} className="checkbox-row">
              <input
                type="checkbox"
                checked={selectedRoles.includes(role.code)}
                onChange={() => toggleRole(role.code)}
              />
              {role.name}
            </label>
          ))}
        </div>

        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? "Creating…" : "Create user"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
