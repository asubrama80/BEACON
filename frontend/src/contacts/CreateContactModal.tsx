import { useState, type FormEvent } from "react";
import Modal from "../components/Modal";
import { createContact, DuplicateContactError } from "./api";
import type { Contact, DuplicateMatch } from "./types";

interface CreateContactModalProps {
  onClose: () => void;
  onCreated: (contact: Contact) => void;
}

export default function CreateContactModal({ onClose, onCreated }: CreateContactModalProps): JSX.Element {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [referenceId, setReferenceId] = useState("");
  const [email, setEmail] = useState("");
  const [mobilePhone, setMobilePhone] = useState("");
  const [department, setDepartment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateMatch[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(confirmDuplicate: boolean): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const contact = await createContact({
        firstName,
        lastName,
        ...(referenceId ? { referenceId } : {}),
        ...(email ? { email } : {}),
        ...(mobilePhone ? { mobilePhone } : {}),
        ...(department ? { department } : {}),
        confirmDuplicate,
      });
      onCreated(contact);
    } catch (err) {
      if (err instanceof DuplicateContactError) {
        setDuplicates(err.duplicates);
      } else {
        setError(err instanceof Error ? err.message : "Unable to create contact.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void submit(false);
  }

  return (
    <Modal title="Add Contact" onClose={onClose}>
      <form className="form-grid" onSubmit={handleSubmit}>
        <label className="form-field">
          <span className="form-label">First name</span>
          <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} required autoFocus />
        </label>
        <label className="form-field">
          <span className="form-label">Last name</span>
          <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} required />
        </label>
        <label className="form-field">
          <span className="form-label">Employee / Reference ID</span>
          <input className="input" value={referenceId} onChange={(e) => setReferenceId(e.target.value)} />
        </label>
        <label className="form-field">
          <span className="form-label">Mobile</span>
          <input className="input" type="tel" placeholder="555-000-0000" value={mobilePhone} onChange={(e) => setMobilePhone(e.target.value)} />
        </label>
        <label className="form-field">
          <span className="form-label">Email</span>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="form-field">
          <span className="form-label">Department</span>
          <input className="input" value={department} onChange={(e) => setDepartment(e.target.value)} />
        </label>

        {duplicates && duplicates.length > 0 && (
          <div className="warning-banner" role="alert">
            <p style={{ margin: 0 }}>This looks like an existing contact:</p>
            <ul className="duplicate-match-list">
              {duplicates.map((match) => (
                <li key={match.id} className="duplicate-match-item">
                  <strong>{match.displayName}</strong> — matched on {match.matchedOn.join(", ")}
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          {duplicates && duplicates.length > 0 ? (
            <button type="button" className="btn btn-primary" disabled={submitting} onClick={() => void submit(true)}>
              {submitting ? "Creating…" : "Create anyway"}
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? "Creating…" : "Save Contact"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
