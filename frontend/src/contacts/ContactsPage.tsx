import { useCallback, useEffect, useState } from "react";
import "./ContactsPage.css";
import { listContacts } from "./api";
import type { Contact } from "./types";
import CreateContactModal from "./CreateContactModal";
import ContactDetailModal from "./ContactDetailModal";
import ContactImportPage from "../contactImport/ContactImportPage";
import { useAuth } from "../auth/useAuth";

export default function ContactsPage(): JSX.Element {
  const { user } = useAuth();
  const [items, setItems] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);

  const canCreate = user?.permissions.includes("contacts.create") ?? false;
  const canImport = user?.permissions.includes("contacts.import") ?? false;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listContacts({ search: search || undefined, status: status || undefined });
      setItems(response.items);
      setTotal(response.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load contacts.");
    } finally {
      setLoading(false);
    }
  }, [search, status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (showImport) {
    return (
      <ContactImportPage
        onDone={() => {
          setShowImport(false);
          void refresh();
        }}
      />
    );
  }

  return (
    <div className="contacts-page">
      <h2 className="page-heading">Contacts</h2>
      <p className="page-lede">The people BEACON can reach directly by SMS and email.</p>

      <div className="toolbar">
        <div className="filter-row" style={{ marginBottom: 0 }}>
          <div className="search-field">
            <input
              className="input"
              placeholder="Search contacts by name, ID, or email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All Statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <div className="toolbar-actions">
          {canImport && (
            <button type="button" className="btn btn-secondary" onClick={() => setShowImport(true)}>
              Import Contacts
            </button>
          )}
          {canCreate && (
            <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
              Add Contact
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Employee ID</th>
                <th>Mobile</th>
                <th>Email</th>
                <th>Department</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((contact) => (
                <tr key={contact.id} className="clickable" onClick={() => setSelectedContactId(contact.id)}>
                  <td className="cell-primary">{contact.displayName}</td>
                  <td className="cell-muted">{contact.referenceId ?? "—"}</td>
                  <td className="cell-muted">{contact.mobilePhone ?? "—"}</td>
                  <td className="cell-muted">{contact.email ?? "—"}</td>
                  <td className="cell-muted">{contact.department ?? "—"}</td>
                  <td>
                    <span className={`badge ${contact.status === "active" ? "badge-success" : "badge-warning"}`}>
                      {contact.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && items.length === 0 && (
            <div className="empty-state">
              <p>No contacts found.</p>
            </div>
          )}
        </div>
      </div>

      <p className="cell-muted" style={{ marginTop: 10 }}>
        {total} contact{total === 1 ? "" : "s"}
      </p>

      {showCreate && (
        <CreateContactModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void refresh();
          }}
        />
      )}

      {selectedContactId && (
        <ContactDetailModal
          contactId={selectedContactId}
          onClose={() => {
            setSelectedContactId(null);
            void refresh();
          }}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}
