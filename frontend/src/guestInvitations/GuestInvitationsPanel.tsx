import { useCallback, useEffect, useState } from "react";
import { createGuestInvitation, listGuestInvitations, revokeGuestInvitation } from "./api";
import type { GuestInvitation } from "./types";

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  sent: "Sent",
  verified: "Verified",
  joined: "Joined",
  expired: "Expired",
  revoked: "Revoked",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "badge-neutral",
  sent: "badge-neutral",
  verified: "badge-success",
  joined: "badge-success",
  expired: "badge-warning",
  revoked: "badge-critical",
};

interface GuestInvitationsPanelProps {
  incidentId: string;
  canRead: boolean;
  canInvite: boolean;
  canRevoke: boolean;
  isClosed: boolean;
}

/**
 * Guest invitation management — never displays a token hash, and the raw invitation link is
 * shown only once, immediately after creation, clearly labeled dev-only (this deployment has no
 * real SMS/email delivery, so a manager needs some way to hand the link to a guest during
 * testing). See claude/prompts/17-guest-invitations.md, "Frontend".
 */
export default function GuestInvitationsPanel({ incidentId, canRead, canInvite, canRevoke, isClosed }: GuestInvitationsPanelProps): JSX.Element {
  const [invitations, setInvitations] = useState<GuestInvitation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [email, setEmail] = useState("");
  const [mobilePhone, setMobilePhone] = useState("");
  const [allowChat, setAllowChat] = useState(true);
  const [allowWarRoom, setAllowWarRoom] = useState(false);
  const [justCreatedUrl, setJustCreatedUrl] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setInvitations(await listGuestInvitations(incidentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load guest invitations.");
    }
  }, [incidentId]);

  useEffect(() => {
    if (canRead) void refresh();
  }, [canRead, refresh]);

  async function handleCreate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await createGuestInvitation(incidentId, {
        guestName,
        email: email.trim() || undefined,
        mobilePhone: mobilePhone.trim() || undefined,
        capabilities: { chat: allowChat, warRoom: allowWarRoom },
      });
      setJustCreatedUrl(result.invitationUrl);
      setGuestName("");
      setEmail("");
      setMobilePhone("");
      setAllowChat(true);
      setAllowWarRoom(false);
      setShowForm(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create the guest invitation.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(invitationId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await revokeGuestInvitation(incidentId, invitationId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to revoke this invitation.");
    } finally {
      setBusy(false);
    }
  }

  if (!canRead) {
    return <p className="cell-muted">You don't have permission to view this incident's guest invitations.</p>;
  }

  return (
    <div className="detail-section">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div className="detail-section-title" style={{ marginBottom: 0 }}>
          Guest Invitations
        </div>
        {canInvite && !isClosed && !showForm && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>
            Invite Guest
          </button>
        )}
      </div>

      {error && (
        <p className="error-banner" role="alert" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      {justCreatedUrl && (
        <div className="card" style={{ padding: 12, marginBottom: 12, background: "var(--surface-alt, #f3f4f6)" }}>
          <p className="cell-primary" style={{ marginBottom: 4 }}>
            DEV ONLY — invitation link (shown once; this environment has no real SMS/email delivery)
          </p>
          <code style={{ wordBreak: "break-all" }}>{justCreatedUrl}</code>
          <div className="detail-actions" style={{ marginTop: 8 }}>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setJustCreatedUrl(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {showForm && (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div className="form-row">
            <label htmlFor="guest-name">Guest name</label>
            <input id="guest-name" type="text" value={guestName} onChange={(e) => setGuestName(e.target.value)} />
          </div>
          <div className="form-row">
            <label htmlFor="guest-email">Email</label>
            <input id="guest-email" type="text" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="guest@example.com" />
          </div>
          <div className="form-row">
            <label htmlFor="guest-phone">Mobile phone</label>
            <input id="guest-phone" type="text" value={mobilePhone} onChange={(e) => setMobilePhone(e.target.value)} placeholder="(555) 555-0100" />
          </div>
          <div className="form-row">
            <label>
              <input type="checkbox" checked={allowChat} onChange={(e) => setAllowChat(e.target.checked)} /> Allow incident chat
            </label>
          </div>
          <div className="form-row">
            <label>
              <input type="checkbox" checked={allowWarRoom} onChange={(e) => setAllowWarRoom(e.target.checked)} /> Allow War Room access
            </label>
          </div>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowForm(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || guestName.trim().length === 0 || (email.trim().length === 0 && mobilePhone.trim().length === 0)}
              onClick={() => void handleCreate()}
            >
              Send Invitation
            </button>
          </div>
        </div>
      )}

      {invitations.length === 0 ? (
        <p className="cell-muted">No guest invitations for this Incident yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Guest</th>
                <th>Status</th>
                <th>Capabilities</th>
                <th>Expires</th>
                {canRevoke && <th></th>}
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => (
                <tr key={inv.id}>
                  <td className="cell-primary">{inv.guestName}</td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[inv.status] ?? "badge-neutral"}`}>{STATUS_LABEL[inv.status] ?? inv.status}</span>
                  </td>
                  <td className="cell-muted">
                    {[inv.capabilities.chat ? "Chat" : null, inv.capabilities.warRoom ? "War Room" : null].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="cell-muted">{new Date(inv.expiresAt).toLocaleString()}</td>
                  {canRevoke && (
                    <td>
                      {inv.status !== "revoked" && (
                        <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void handleRevoke(inv.id)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
