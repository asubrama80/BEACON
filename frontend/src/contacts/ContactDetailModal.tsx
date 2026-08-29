import { useEffect, useState } from "react";
import Modal from "../components/Modal";
import { disableContact, enableContact, getContact, updateContact, DuplicateContactError } from "./api";
import type { Contact, DuplicateMatch } from "./types";
import { useAuth } from "../auth/useAuth";

interface ContactDetailModalProps {
  contactId: string;
  onClose: () => void;
  onChanged: (contact: Contact) => void;
}

export default function ContactDetailModal({ contactId, onClose, onChanged }: ContactDetailModalProps): JSX.Element {
  const { user } = useAuth();
  const [contact, setContact] = useState<Contact | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [referenceId, setReferenceId] = useState("");
  const [email, setEmail] = useState("");
  const [mobilePhone, setMobilePhone] = useState("");
  const [department, setDepartment] = useState("");
  const [duplicates, setDuplicates] = useState<DuplicateMatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDisable, setConfirmingDisable] = useState(false);

  const canUpdate = user?.permissions.includes("contacts.update") ?? false;
  const canDisable = user?.permissions.includes("contacts.disable") ?? false;

  async function refresh(): Promise<void> {
    const fresh = await getContact(contactId);
    setContact(fresh);
    setFirstName(fresh.firstName);
    setLastName(fresh.lastName);
    setReferenceId(fresh.referenceId ?? "");
    setEmail(fresh.email ?? "");
    setMobilePhone(fresh.mobilePhone ?? "");
    setDepartment(fresh.department ?? "");
    onChanged(fresh);
  }

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load contact."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  async function saveDetails(confirmDuplicate: boolean): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await updateContact(contactId, { firstName, lastName, referenceId, email, mobilePhone, department, confirmDuplicate });
      setDuplicates(null);
      await refresh();
    } catch (err) {
      if (err instanceof DuplicateContactError) {
        setDuplicates(err.duplicates);
      } else {
        setError(err instanceof Error ? err.message : "Unable to update contact.");
      }
    } finally {
      setBusy(false);
    }
  }

  if (!contact) {
    return (
      <Modal title="Contact" onClose={onClose}>
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
    <Modal title={contact.displayName} onClose={onClose}>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="detail-section">
        <div className="detail-section-title">Status</div>
        <span className={`badge ${contact.status === "active" ? "badge-success" : "badge-warning"}`}>
          {contact.status}
        </span>
      </div>

      <div className="detail-section">
        <div className="detail-section-title">Details</div>
        <div className="form-grid">
          <label className="form-field">
            <span className="form-label">First name</span>
            <input className="input" value={firstName} onChange={(e) => setFirstName(e.target.value)} disabled={!canUpdate} />
          </label>
          <label className="form-field">
            <span className="form-label">Last name</span>
            <input className="input" value={lastName} onChange={(e) => setLastName(e.target.value)} disabled={!canUpdate} />
          </label>
          <label className="form-field">
            <span className="form-label">Employee / Reference ID</span>
            <input className="input" value={referenceId} onChange={(e) => setReferenceId(e.target.value)} disabled={!canUpdate} />
          </label>
          <label className="form-field">
            <span className="form-label">Mobile</span>
            <input className="input" type="tel" value={mobilePhone} onChange={(e) => setMobilePhone(e.target.value)} disabled={!canUpdate} />
          </label>
          <label className="form-field">
            <span className="form-label">Email</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={!canUpdate} />
          </label>
          <label className="form-field">
            <span className="form-label">Department</span>
            <input className="input" value={department} onChange={(e) => setDepartment(e.target.value)} disabled={!canUpdate} />
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

          {canUpdate && (
            <div className="form-actions">
              {duplicates && duplicates.length > 0 ? (
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void saveDetails(true)}>
                  Save anyway
                </button>
              ) : (
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void saveDetails(false)}>
                  Save details
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {canDisable && (
        <div className="detail-section">
          <div className="detail-actions">
            {contact.status === "active" ? (
              confirmingDisable ? (
                <>
                  <span className="cell-muted">Disable this contact?</span>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={() =>
                      void (async () => {
                        setBusy(true);
                        try {
                          await disableContact(contactId);
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
                  Disable contact
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
                      await enableContact(contactId);
                      await refresh();
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                Re-enable contact
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
