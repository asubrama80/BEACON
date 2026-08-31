import { useCallback, useEffect, useState } from "react";
import "./GroupsPage.css";
import { listGroups } from "./api";
import type { Group } from "./types";
import CreateGroupModal from "./CreateGroupModal";
import GroupDetailModal from "./GroupDetailModal";
import GroupMembersModal from "./GroupMembersModal";
import { useAuth } from "../auth/useAuth";

export default function GroupsPage(): JSX.Element {
  const { user } = useAuth();
  const [items, setItems] = useState<Group[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [detailGroupId, setDetailGroupId] = useState<string | null>(null);
  const [membersGroup, setMembersGroup] = useState<{ id: string; name: string } | null>(null);

  const canCreate = user?.permissions.includes("groups.create") ?? false;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listGroups({ search: search || undefined, status: status || undefined });
      setItems(response.items);
      setTotal(response.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load groups.");
    } finally {
      setLoading(false);
    }
  }, [search, status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="groups-page">
      <h2 className="page-heading">Groups</h2>
      <p className="page-lede">Distribution lists you can target when composing an alert.</p>

      <div className="toolbar">
        <div className="filter-row" style={{ marginBottom: 0 }}>
          <div className="search-field">
            <input
              className="input"
              placeholder="Search groups by name"
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
          {canCreate && (
            <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
              Create Group
            </button>
          )}
        </div>
      </div>

      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="group-card-grid">
        {items.map((group) => (
          <div key={group.id} className="card group-tile">
            <div className="group-tile-top">
              <div>
                <div className="group-tile-name">{group.name}</div>
                <div className="group-tile-count">
                  {group.memberCount} member{group.memberCount === 1 ? "" : "s"} ({group.activeMemberCount} active)
                </div>
              </div>
              <span className={`badge ${group.status === "active" ? "badge-success" : "badge-warning"}`}>{group.status}</span>
            </div>
            {group.description && <p className="cell-muted">{group.description}</p>}
            <div className="group-tile-actions">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDetailGroupId(group.id)}>
                View / Edit
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setMembersGroup({ id: group.id, name: group.name })}
              >
                Members
              </button>
            </div>
          </div>
        ))}
      </div>

      {!loading && items.length === 0 && (
        <div className="card empty-state">
          <p>No groups found.</p>
        </div>
      )}

      <p className="cell-muted" style={{ marginTop: 10 }}>
        {total} group{total === 1 ? "" : "s"}
      </p>

      {showCreate && (
        <CreateGroupModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void refresh();
          }}
        />
      )}

      {detailGroupId && (
        <GroupDetailModal
          groupId={detailGroupId}
          onClose={() => {
            setDetailGroupId(null);
            void refresh();
          }}
          onChanged={() => void refresh()}
          onManageMembers={() => {
            const group = items.find((g) => g.id === detailGroupId);
            setDetailGroupId(null);
            setMembersGroup({ id: detailGroupId, name: group?.name ?? "" });
          }}
        />
      )}

      {membersGroup && (
        <GroupMembersModal
          groupId={membersGroup.id}
          groupName={membersGroup.name}
          onClose={() => {
            setMembersGroup(null);
            void refresh();
          }}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}
