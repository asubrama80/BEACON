import { useEffect, useState } from "react";
import Modal from "../components/Modal";
import { disableGroup, enableGroup, getGroup, updateGroup } from "./api";
import type { Group } from "./types";
import { useAuth } from "../auth/useAuth";

interface GroupDetailModalProps {
  groupId: string;
  onClose: () => void;
  onChanged: (group: Group) => void;
  onManageMembers: () => void;
}

export default function GroupDetailModal({ groupId, onClose, onChanged, onManageMembers }: GroupDetailModalProps): JSX.Element {
  const { user } = useAuth();
  const [group, setGroup] = useState<Group | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingDisable, setConfirmingDisable] = useState(false);

  const canUpdate = user?.permissions.includes("groups.update") ?? false;
  const canDisable = user?.permissions.includes("groups.disable") ?? false;
  const canManageMembers = user?.permissions.includes("groups.members.manage") ?? false;

  async function refresh(): Promise<void> {
    const fresh = await getGroup(groupId);
    setGroup(fresh);
    setName(fresh.name);
    setDescription(fresh.description ?? "");
    onChanged(fresh);
  }

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load group."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  async function saveDetails(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await updateGroup(groupId, { name, description });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update group.");
    } finally {
      setBusy(false);
    }
  }

  if (!group) {
    return (
      <Modal title="Group" onClose={onClose}>
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
    <Modal title={group.name} onClose={onClose}>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="detail-section">
        <div className="detail-section-title">Status</div>
        <span className={`badge ${group.status === "active" ? "badge-success" : "badge-warning"}`}>{group.status}</span>
        <span className="cell-muted" style={{ marginLeft: 12 }}>
          {group.memberCount} member{group.memberCount === 1 ? "" : "s"} ({group.activeMemberCount} active)
        </span>
      </div>

      <div className="detail-section">
        <div className="detail-section-title">Details</div>
        <div className="form-grid">
          <label className="form-field">
            <span className="form-label">Group name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={!canUpdate} />
          </label>
          <label className="form-field">
            <span className="form-label">Description</span>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canUpdate} />
          </label>
          {canUpdate && (
            <div className="form-actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void saveDetails()}>
                Save details
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="detail-section">
        <div className="detail-actions">
          {canManageMembers && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onManageMembers}>
              Manage Members
            </button>
          )}
          {canDisable &&
            (group.status === "active" ? (
              confirmingDisable ? (
                <>
                  <span className="cell-muted">Disable this group?</span>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={() =>
                      void (async () => {
                        setBusy(true);
                        try {
                          await disableGroup(groupId);
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
                  Disable group
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
                      await enableGroup(groupId);
                      await refresh();
                    } finally {
                      setBusy(false);
                    }
                  })()
                }
              >
                Re-enable group
              </button>
            ))}
        </div>
      </div>
    </Modal>
  );
}
