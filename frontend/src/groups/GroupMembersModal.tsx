import { useCallback, useEffect, useState } from "react";
import Modal from "../components/Modal";
import { addGroupMembers, listGroupMembers, removeGroupMember } from "./api";
import type { GroupMember } from "./types";
import { listContacts } from "../contacts/api";
import type { Contact } from "../contacts/types";
import { useAuth } from "../auth/useAuth";

interface GroupMembersModalProps {
  groupId: string;
  groupName: string;
  onClose: () => void;
  onChanged: () => void;
}

export default function GroupMembersModal({ groupId, groupName, onClose, onChanged }: GroupMembersModalProps): JSX.Element {
  const { user } = useAuth();
  const canManage = user?.permissions.includes("groups.members.manage") ?? false;

  const [members, setMembers] = useState<GroupMember[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [loadingMembers, setLoadingMembers] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [contactSearch, setContactSearch] = useState("");
  const [contactResults, setContactResults] = useState<Contact[]>([]);
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set());
  const [addBusy, setAddBusy] = useState(false);

  const refreshMembers = useCallback(async () => {
    setLoadingMembers(true);
    try {
      const response = await listGroupMembers(groupId, { search: memberSearch || undefined });
      setMembers(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load members.");
    } finally {
      setLoadingMembers(false);
    }
  }, [groupId, memberSearch]);

  useEffect(() => {
    void refreshMembers();
  }, [refreshMembers]);

  async function searchContacts(): Promise<void> {
    if (!contactSearch.trim()) {
      setContactResults([]);
      return;
    }
    try {
      const response = await listContacts({ search: contactSearch, status: "active" });
      setContactResults(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to search contacts.");
    }
  }

  function toggleSelected(contactId: string): void {
    setSelectedContactIds((prev) => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  }

  async function addSelected(): Promise<void> {
    if (selectedContactIds.size === 0) return;
    setAddBusy(true);
    setError(null);
    try {
      await addGroupMembers(groupId, [...selectedContactIds]);
      setSelectedContactIds(new Set());
      setContactResults([]);
      setContactSearch("");
      await refreshMembers();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add members.");
    } finally {
      setAddBusy(false);
    }
  }

  async function handleRemove(contactId: string): Promise<void> {
    setError(null);
    try {
      await removeGroupMember(groupId, contactId);
      await refreshMembers();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove this member.");
    }
  }

  const existingMemberIds = new Set(members.map((m) => m.contactId));

  return (
    <Modal title={`Manage Members — ${groupName}`} onClose={onClose}>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {canManage && (
        <div className="detail-section">
          <div className="detail-section-title">Add Contacts</div>
          <div className="filter-row">
            <div className="search-field">
              <input
                className="input"
                placeholder="Search contacts by name, ID, or email"
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void searchContacts();
                  }
                }}
              />
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void searchContacts()}>
              Search
            </button>
          </div>

          {contactResults.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <tbody>
                  {contactResults.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${c.displayName}`}
                          checked={selectedContactIds.has(c.id)}
                          disabled={existingMemberIds.has(c.id)}
                          onChange={() => toggleSelected(c.id)}
                        />
                      </td>
                      <td className="cell-primary">{c.displayName}</td>
                      <td className="cell-muted">{c.email ?? c.mobilePhone ?? "—"}</td>
                      <td className="cell-muted">{existingMemberIds.has(c.id) ? "Already a member" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="form-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={addBusy || selectedContactIds.size === 0} onClick={() => void addSelected()}>
              {addBusy ? "Adding…" : `Add Selected (${selectedContactIds.size})`}
            </button>
          </div>
        </div>
      )}

      <div className="detail-section">
        <div className="detail-section-title">Current Members ({members.length})</div>
        <input
          className="input"
          placeholder="Search current members"
          value={memberSearch}
          onChange={(e) => setMemberSearch(e.target.value)}
          style={{ marginBottom: 10 }}
        />
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Mobile</th>
                <th>Status</th>
                {canManage && <th></th>}
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.contactId}>
                  <td className="cell-primary">{m.displayName}</td>
                  <td className="cell-muted">{m.email ?? "—"}</td>
                  <td className="cell-muted">{m.mobilePhone ?? "—"}</td>
                  <td>
                    <span className={`badge ${m.contactStatus === "active" ? "badge-success" : "badge-warning"}`}>{m.contactStatus}</span>
                  </td>
                  {canManage && (
                    <td>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void handleRemove(m.contactId)}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!loadingMembers && members.length === 0 && (
            <div className="empty-state">
              <p>No members yet.</p>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
