import { useCallback, useEffect, useState } from "react";
import "./UsersPage.css";
import { listUsers } from "./api";
import type { UserSummary } from "./types";
import CreateUserModal from "./CreateUserModal";
import UserDetailModal from "./UserDetailModal";
import { useAuth } from "../auth/useAuth";

export default function UsersPage(): JSX.Element {
  const { user: currentUser } = useAuth();
  const [items, setItems] = useState<UserSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const canCreate = currentUser?.permissions.includes("users.create") ?? false;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await listUsers({ search: search || undefined, status: status || undefined });
      setItems(response.items);
      setTotal(response.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load users.");
    } finally {
      setLoading(false);
    }
  }, [search, status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="users-page">
      <h2 className="page-heading">Users</h2>
      <p className="page-lede">Registered BEACON accounts and their assigned roles.</p>

      <div className="toolbar">
        <div className="filter-row" style={{ marginBottom: 0 }}>
          <div className="search-field">
            <input
              className="input"
              placeholder="Search by email or name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="suspended">Suspended</option>
          </select>
        </div>
        <div className="toolbar-actions">
          {canCreate && (
            <button type="button" className="btn btn-primary" onClick={() => setShowCreate(true)}>
              New user
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
                <th>Email</th>
                <th>Status</th>
                <th>Roles</th>
              </tr>
            </thead>
            <tbody>
              {items.map((user) => (
                <tr key={user.id} className="clickable" onClick={() => setSelectedUserId(user.id)}>
                  <td className="cell-primary">
                    {user.displayName}
                    {user.isBreakGlass && (
                      <span className="badge badge-critical" style={{ marginLeft: 8 }}>
                        Break-glass
                      </span>
                    )}
                  </td>
                  <td className="cell-muted">{user.email}</td>
                  <td>
                    <span className={`badge ${user.status === "active" ? "badge-success" : "badge-warning"}`}>
                      {user.status}
                    </span>
                  </td>
                  <td>
                    {user.roles.length === 0 ? (
                      <span className="cell-muted">None</span>
                    ) : (
                      user.roles.map((role) => (
                        <span key={role.id} className="role-chip">
                          {role.code}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && items.length === 0 && (
            <div className="empty-state">
              <p>No users found.</p>
            </div>
          )}
        </div>
      </div>

      <p className="cell-muted" style={{ marginTop: 10 }}>
        {total} user{total === 1 ? "" : "s"}
      </p>

      {showCreate && (
        <CreateUserModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void refresh();
          }}
        />
      )}

      {selectedUserId && (
        <UserDetailModal
          userId={selectedUserId}
          onClose={() => {
            setSelectedUserId(null);
            void refresh();
          }}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}
