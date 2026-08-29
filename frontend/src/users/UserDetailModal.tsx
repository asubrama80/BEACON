import { useEffect, useState } from "react";
import Modal from "./Modal";
import {
  assignRole,
  disableUser,
  enableUser,
  getUser,
  listRoles,
  removeRole,
  resetPassword,
  updateUser,
} from "./api";
import type { RoleRef, UserDetail } from "./types";
import { useAuth } from "../auth/useAuth";

interface UserDetailModalProps {
  userId: string;
  onClose: () => void;
  onChanged: (user: UserDetail) => void;
}

export default function UserDetailModal({ userId, onClose, onChanged }: UserDetailModalProps): JSX.Element {
  const { user: currentUser } = useAuth();
  const [detail, setDetail] = useState<UserDetail | null>(null);
  const [roles, setRoles] = useState<RoleRef[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDisable, setConfirmingDisable] = useState(false);

  const canManageRoles = currentUser?.permissions.includes("users.roles.assign") ?? false;
  const canUpdate = currentUser?.permissions.includes("users.update") ?? false;
  const canDisable = currentUser?.permissions.includes("users.disable") ?? false;

  async function refresh(): Promise<void> {
    const fresh = await getUser(userId);
    setDetail(fresh);
    setDisplayName(fresh.displayName);
    setEmail(fresh.email);
    onChanged(fresh);
  }

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load user."));
    listRoles()
      .then(setRoles)
      .catch(() => setRoles([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function withBusy(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <Modal title="User" onClose={onClose}>
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

  const assignedCodes = detail.roles.map((r) => r.code);
  const isSelf = currentUser?.id === detail.id;

  return (
    <Modal title={detail.displayName} onClose={onClose}>
      {detail.isBreakGlass && (
        <p className="error-banner" role="status">
          This is the protected break-glass account. It cannot be edited here.
        </p>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="detail-section">
        <div className="detail-section-title">Status</div>
        <span className={`badge ${detail.status === "active" ? "badge-success" : "badge-warning"}`}>
          {detail.status}
        </span>
      </div>

      {!detail.isBreakGlass && canUpdate && (
        <div className="detail-section">
          <div className="detail-section-title">Details</div>
          <div className="form-grid">
            <label className="form-field">
              <span className="form-label">Display name</span>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </label>
            <label className="form-field">
              <span className="form-label">Email</span>
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() =>
                  void withBusy(async () => {
                    await updateUser(detail.id, { displayName, email });
                    await refresh();
                  })
                }
              >
                Save details
              </button>
            </div>
          </div>
        </div>
      )}

      {!detail.isBreakGlass && canManageRoles && (
        <div className="detail-section">
          <div className="detail-section-title">Roles</div>
          {roles.map((role) => {
            const assigned = assignedCodes.includes(role.code);
            const blockRemoval = role.code === "ADMIN" && isSelf;
            return (
              <label className="checkbox-row" key={role.id} title={blockRemoval ? "Use another admin account to remove your own ADMIN role." : undefined}>
                <input
                  type="checkbox"
                  checked={assigned}
                  disabled={busy}
                  onChange={() =>
                    void withBusy(async () => {
                      if (assigned) {
                        await removeRole(detail.id, role.code);
                      } else {
                        await assignRole(detail.id, role.code);
                      }
                      await refresh();
                    })
                  }
                />
                {role.name}
              </label>
            );
          })}
        </div>
      )}

      <div className="detail-section">
        <div className="detail-section-title">Effective permissions</div>
        <div className="permission-list">
          {detail.effectivePermissions.length === 0 ? (
            <span className="cell-muted">None</span>
          ) : (
            detail.effectivePermissions.map((code) => (
              <span key={code} className="permission-chip">
                {code}
              </span>
            ))
          )}
        </div>
      </div>

      {!detail.isBreakGlass && canUpdate && (
        <div className="detail-section">
          <div className="detail-section-title">Reset password</div>
          <div className="form-grid">
            <input
              className="input"
              type="password"
              placeholder="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy || !newPassword}
                onClick={() =>
                  void withBusy(async () => {
                    await resetPassword(detail.id, newPassword);
                    setNewPassword("");
                  })
                }
              >
                Reset password (revokes sessions)
              </button>
            </div>
          </div>
        </div>
      )}

      {!detail.isBreakGlass && canDisable && (
        <div className="detail-section">
          <div className="detail-actions">
            {detail.status === "active" ? (
              confirmingDisable ? (
                <>
                  <span className="cell-muted">Disable this account and revoke its sessions?</span>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={() =>
                      void withBusy(async () => {
                        await disableUser(detail.id);
                        setConfirmingDisable(false);
                        await refresh();
                      })
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
                  Disable user
                </button>
              )
            ) : (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={busy}
                onClick={() =>
                  void withBusy(async () => {
                    await enableUser(detail.id);
                    await refresh();
                  })
                }
              >
                Re-enable user
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
