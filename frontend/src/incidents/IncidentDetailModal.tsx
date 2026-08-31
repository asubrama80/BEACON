import { useCallback, useEffect, useState } from "react";
import Modal from "../components/Modal";
import {
  activateIncident,
  addContactParticipant,
  addUserParticipant,
  assignCommander,
  closeIncident,
  getCommandCenter,
  getIncident,
  listParticipants,
  listTimeline,
  removeParticipant,
  reopenIncident,
  resolveIncident,
  updateIncident,
} from "./api";
import type { CommandCenter, Incident, IncidentSeverity, Participant, TimelineEvent } from "./types";
import { listUsers } from "../users/api";
import type { UserSummary } from "../users/types";
import { listContacts } from "../contacts/api";
import type { Contact } from "../contacts/types";
import { useAuth } from "../auth/useAuth";
import ChatPanel from "../chat/ChatPanel";
import WarRoomPanel from "../warRoom/WarRoomPanel";
import GuestInvitationsPanel from "../guestInvitations/GuestInvitationsPanel";

interface NavigateToAlertsRequest {
  alertId?: string;
  createIncidentId?: string;
}

interface IncidentDetailModalProps {
  incidentId: string;
  onClose: () => void;
  onChanged: () => void;
  /** Optional cross-page navigation hook — lets Command Center deep-link into the Alerts page. */
  onNavigateToAlerts?: (request: NavigateToAlertsRequest) => void;
}

type Tab = "overview" | "commandCenter" | "participants" | "timeline" | "chat" | "warRoom" | "guests";

const STATUS_BADGE: Record<string, string> = {
  open: "badge-neutral",
  active: "badge-critical",
  resolved: "badge-warning",
  closed: "badge-success",
};

export default function IncidentDetailModal({
  incidentId,
  onClose,
  onChanged,
  onNavigateToAlerts,
}: IncidentDetailModalProps): JSX.Element {
  const { user } = useAuth();
  const canUpdate = user?.permissions.includes("incidents.update") ?? false;
  const canManageLifecycle = user?.permissions.includes("incidents.lifecycle.manage") ?? false;
  const canAssignCommander = user?.permissions.includes("incidents.commander.assign") ?? false;
  const canManageParticipants = user?.permissions.includes("incidents.participants.manage") ?? false;
  const canReadParticipants =
    (user?.permissions.includes("incidents.read") ?? false) && (user?.permissions.includes("contacts.read") ?? false);
  const canReadTimeline = user?.permissions.includes("incidents.timeline.read") ?? false;
  const canReadCommandCenter = user?.permissions.includes("incidents.command_center.read") ?? false;
  const canCreateAlert = user?.permissions.includes("alerts.create") ?? false;
  const canReadChat = user?.permissions.includes("incidents.chat.read") ?? false;
  const canSendChat = user?.permissions.includes("incidents.chat.send") ?? false;
  const canReadWarRoom = user?.permissions.includes("incidents.war_room.read") ?? false;
  const canManageWarRoom = user?.permissions.includes("incidents.war_room.manage") ?? false;
  const canJoinWarRoom = user?.permissions.includes("incidents.war_room.join") ?? false;
  const canReadGuests = user?.permissions.includes("incidents.guests.read") ?? false;
  const canInviteGuests = user?.permissions.includes("incidents.guests.invite") ?? false;
  const canRevokeGuests = user?.permissions.includes("incidents.guests.revoke") ?? false;

  const [tab, setTab] = useState<Tab>("overview");
  const [incident, setIncident] = useState<Incident | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<IncidentSeverity>("info");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isClosed = incident?.status === "closed";

  const refresh = useCallback(async () => {
    const fresh = await getIncident(incidentId);
    setIncident(fresh);
    setTitle(fresh.title);
    setDescription(fresh.description ?? "");
    setSeverity(fresh.severity);
    onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentId]);

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load incident."));
  }, [refresh]);

  async function saveDetails(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await updateIncident(incidentId, { title, description, severity });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update incident.");
    } finally {
      setBusy(false);
    }
  }

  async function runTransition(fn: (id: string) => Promise<Incident>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn(incidentId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to change incident status.");
    } finally {
      setBusy(false);
    }
  }

  if (!incident) {
    return (
      <Modal title="Incident" onClose={onClose}>
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
    <Modal title={`${incident.incidentNumber} — ${incident.title}`} onClose={onClose}>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="detail-section">
        <span className={`badge ${STATUS_BADGE[incident.status] ?? "badge-neutral"}`}>{incident.status}</span>
        <span className="cell-muted" style={{ marginLeft: 12 }}>
          {incident.participantCount} participant{incident.participantCount === 1 ? "" : "s"} (
          {incident.registeredUserCount} responder{incident.registeredUserCount === 1 ? "" : "s"},{" "}
          {incident.contactParticipantCount} contact{incident.contactParticipantCount === 1 ? "" : "s"})
        </span>
      </div>

      {isClosed && (
        <p className="warning-banner">
          This incident is closed. Its record is read-only — no further edits, roster changes, or lifecycle actions
          are permitted.
        </p>
      )}

      <div className="tab-row" style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          className={`btn btn-sm ${tab === "overview" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        {canReadCommandCenter && (
          <button
            type="button"
            className={`btn btn-sm ${tab === "commandCenter" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setTab("commandCenter")}
          >
            Command Center
          </button>
        )}
        <button
          type="button"
          className={`btn btn-sm ${tab === "participants" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setTab("participants")}
        >
          Participants
        </button>
        <button
          type="button"
          className={`btn btn-sm ${tab === "timeline" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setTab("timeline")}
        >
          Timeline
        </button>
        {canReadChat && (
          <button
            type="button"
            className={`btn btn-sm ${tab === "chat" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setTab("chat")}
          >
            Chat
          </button>
        )}
        {canReadWarRoom && (
          <button
            type="button"
            className={`btn btn-sm ${tab === "warRoom" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setTab("warRoom")}
          >
            War Room
          </button>
        )}
        {canReadGuests && (
          <button
            type="button"
            className={`btn btn-sm ${tab === "guests" ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setTab("guests")}
          >
            Guest Invitations
          </button>
        )}
      </div>

      {tab === "overview" && (
        <OverviewTab
          incident={incident}
          title={title}
          description={description}
          severity={severity}
          setTitle={setTitle}
          setDescription={setDescription}
          setSeverity={setSeverity}
          canUpdate={canUpdate && !isClosed}
          canManageLifecycle={canManageLifecycle && !isClosed}
          canAssignCommander={canAssignCommander && !isClosed}
          busy={busy}
          onSaveDetails={() => void saveDetails()}
          onActivate={() => void runTransition(activateIncident)}
          onResolve={() => void runTransition(resolveIncident)}
          onClose={() => void runTransition(closeIncident)}
          onReopen={() => void runTransition(reopenIncident)}
          onAssignCommander={(userId) =>
            void (async () => {
              setBusy(true);
              setError(null);
              try {
                await assignCommander(incidentId, userId);
                await refresh();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Unable to assign commander.");
              } finally {
                setBusy(false);
              }
            })()
          }
        />
      )}

      {tab === "commandCenter" && (
        <CommandCenterTab
          incidentId={incidentId}
          canCreateAlert={canCreateAlert && !isClosed}
          onNavigateToAlerts={onNavigateToAlerts}
        />
      )}

      {tab === "participants" && (
        <ParticipantsTab
          incidentId={incidentId}
          canRead={canReadParticipants}
          canManage={canManageParticipants && !isClosed}
          onRosterChanged={() => void refresh()}
        />
      )}

      {tab === "timeline" && <TimelineTab incidentId={incidentId} canRead={canReadTimeline} />}

      {tab === "chat" && user && (
        <ChatPanel incidentId={incidentId} canRead={canReadChat} canSend={canSendChat} isClosed={isClosed} currentUserId={user.id} />
      )}

      {tab === "warRoom" && user && (
        <WarRoomPanel
          incidentId={incidentId}
          incidentNumber={incident.incidentNumber}
          incidentTitle={incident.title}
          canRead={canReadWarRoom}
          canManage={canManageWarRoom}
          canJoin={canJoinWarRoom}
          isClosed={isClosed}
          currentUserId={user.id}
          currentUserDisplayName={user.displayName}
        />
      )}

      {tab === "guests" && (
        <GuestInvitationsPanel
          incidentId={incidentId}
          canRead={canReadGuests}
          canInvite={canInviteGuests}
          canRevoke={canRevokeGuests}
          isClosed={isClosed}
        />
      )}
    </Modal>
  );
}

interface OverviewTabProps {
  incident: Incident;
  title: string;
  description: string;
  severity: IncidentSeverity;
  setTitle: (v: string) => void;
  setDescription: (v: string) => void;
  setSeverity: (v: IncidentSeverity) => void;
  canUpdate: boolean;
  canManageLifecycle: boolean;
  canAssignCommander: boolean;
  busy: boolean;
  onSaveDetails: () => void;
  onActivate: () => void;
  onResolve: () => void;
  onClose: () => void;
  onReopen: () => void;
  onAssignCommander: (userId: string) => void;
}

function OverviewTab(props: OverviewTabProps): JSX.Element {
  const {
    incident,
    title,
    description,
    severity,
    setTitle,
    setDescription,
    setSeverity,
    canUpdate,
    canManageLifecycle,
    canAssignCommander,
    busy,
    onSaveDetails,
    onActivate,
    onResolve,
    onClose,
    onReopen,
    onAssignCommander,
  } = props;

  const [commanderSearch, setCommanderSearch] = useState("");
  const [commanderResults, setCommanderResults] = useState<UserSummary[]>([]);
  const [commanderError, setCommanderError] = useState<string | null>(null);

  async function searchCommanders(): Promise<void> {
    if (!commanderSearch.trim()) {
      setCommanderResults([]);
      return;
    }
    try {
      const response = await listUsers({ search: commanderSearch, status: "active" });
      setCommanderResults(response.items);
    } catch (err) {
      setCommanderError(err instanceof Error ? err.message : "Unable to search users.");
    }
  }

  return (
    <>
      <div className="detail-section">
        <div className="detail-section-title">Details</div>
        <div className="form-grid">
          <label className="form-field">
            <span className="form-label">Title</span>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={!canUpdate} />
          </label>
          <label className="form-field">
            <span className="form-label">Description</span>
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!canUpdate}
            />
          </label>
          <label className="form-field">
            <span className="form-label">Severity</span>
            <select
              className="select"
              value={severity}
              onChange={(e) => setSeverity(e.target.value as IncidentSeverity)}
              disabled={!canUpdate}
            >
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </label>
          {canUpdate && (
            <div className="form-actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onSaveDetails}>
                Save details
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="detail-section">
        <div className="detail-section-title">Commander</div>
        <p className="cell-muted" style={{ marginBottom: 8 }}>
          {incident.commander ? `${incident.commander.displayName} (${incident.commander.status})` : "No commander assigned."}
        </p>
        {canAssignCommander && (
          <>
            {commanderError && (
              <p className="error-banner" role="alert">
                {commanderError}
              </p>
            )}
            <div className="filter-row" style={{ marginBottom: 0 }}>
              <div className="search-field">
                <input
                  className="input"
                  placeholder="Search active BEACON users"
                  value={commanderSearch}
                  onChange={(e) => setCommanderSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void searchCommanders();
                    }
                  }}
                />
              </div>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => void searchCommanders()}>
                Search
              </button>
            </div>
            {commanderResults.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <tbody>
                    {commanderResults.map((u) => (
                      <tr
                        key={u.id}
                        className="clickable"
                        onClick={() => {
                          onAssignCommander(u.id);
                          setCommanderResults([]);
                          setCommanderSearch("");
                        }}
                      >
                        <td className="cell-primary">{u.displayName}</td>
                        <td className="cell-muted">{u.email}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <span className="form-hint">
              Assigning or changing the commander here does not modify this user's global account roles.
            </span>
          </>
        )}
      </div>

      {canManageLifecycle && (
        <div className="detail-section">
          <div className="detail-section-title">Lifecycle</div>
          <div className="detail-actions">
            {incident.status === "open" && (
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onActivate}>
                Activate
              </button>
            )}
            {incident.status === "active" && (
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onResolve}>
                Resolve
              </button>
            )}
            {incident.status === "resolved" && (
              <>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onClose}>
                  Close
                </button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onReopen}>
                  Reopen
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

interface ParticipantsTabProps {
  incidentId: string;
  canRead: boolean;
  canManage: boolean;
  onRosterChanged: () => void;
}

function ParticipantsTab({ incidentId, canRead, canManage, onRosterChanged }: ParticipantsTabProps): JSX.Element {
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [userSearch, setUserSearch] = useState("");
  const [userResults, setUserResults] = useState<UserSummary[]>([]);
  const [contactSearch, setContactSearch] = useState("");
  const [contactResults, setContactResults] = useState<Contact[]>([]);
  const [addBusy, setAddBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await listParticipants(incidentId);
      setParticipants(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load participants.");
    } finally {
      setLoading(false);
    }
  }, [incidentId, canRead]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function searchUsers(): Promise<void> {
    if (!userSearch.trim()) {
      setUserResults([]);
      return;
    }
    try {
      const response = await listUsers({ search: userSearch, status: "active" });
      setUserResults(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to search users.");
    }
  }

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

  async function handleAddUser(userId: string): Promise<void> {
    setAddBusy(true);
    setError(null);
    try {
      await addUserParticipant(incidentId, userId);
      setUserResults([]);
      setUserSearch("");
      await refresh();
      onRosterChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add this responder.");
    } finally {
      setAddBusy(false);
    }
  }

  async function handleAddContact(contactId: string): Promise<void> {
    setAddBusy(true);
    setError(null);
    try {
      await addContactParticipant(incidentId, contactId);
      setContactResults([]);
      setContactSearch("");
      await refresh();
      onRosterChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add this contact.");
    } finally {
      setAddBusy(false);
    }
  }

  async function handleRemove(participantId: string): Promise<void> {
    setError(null);
    try {
      await removeParticipant(incidentId, participantId);
      await refresh();
      onRosterChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to remove this participant.");
    }
  }

  if (!canRead) {
    return <p className="cell-muted">You don't have permission to view this incident's roster.</p>;
  }

  return (
    <>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      {canManage && (
        <div className="detail-section">
          <div className="detail-section-title">Add BEACON Responder</div>
          <div className="filter-row" style={{ marginBottom: 0 }}>
            <div className="search-field">
              <input
                className="input"
                placeholder="Search active BEACON users"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void searchUsers();
                  }
                }}
              />
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void searchUsers()}>
              Search
            </button>
          </div>
          {userResults.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <tbody>
                  {userResults.map((u) => (
                    <tr key={u.id}>
                      <td className="cell-primary">{u.displayName}</td>
                      <td className="cell-muted">{u.email}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={addBusy}
                          onClick={() => void handleAddUser(u.id)}
                        >
                          Add
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="detail-section-title" style={{ marginTop: 16 }}>
            Add Contact
          </div>
          <div className="filter-row" style={{ marginBottom: 0 }}>
            <div className="search-field">
              <input
                className="input"
                placeholder="Search active contacts"
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
                      <td className="cell-primary">{c.displayName}</td>
                      <td className="cell-muted">{c.email ?? c.mobilePhone ?? "—"}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={addBusy}
                          onClick={() => void handleAddContact(c.id)}
                        >
                          Add
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <span className="form-hint" style={{ marginTop: 8, display: "block" }}>
            This adds the Contact to the Incident roster only. It does not grant BEACON login access or send an
            invitation.
          </span>
        </div>
      )}

      <div className="detail-section">
        <div className="detail-section-title">Roster ({participants.length})</div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Contact info</th>
                <th>Status</th>
                {canManage && <th></th>}
              </tr>
            </thead>
            <tbody>
              {participants.map((p) => (
                <tr key={p.id}>
                  <td className="cell-primary">{p.displayName}</td>
                  <td className="cell-muted">{p.participantType === "user" ? "BEACON Responder" : "Contact"}</td>
                  <td className="cell-muted">{p.email ?? p.mobilePhone ?? "—"}</td>
                  <td>
                    <span className={`badge ${p.sourceStatus === "active" ? "badge-success" : "badge-warning"}`}>
                      {p.sourceStatus}
                    </span>
                  </td>
                  {canManage && (
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => void handleRemove(p.id)}
                      >
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && participants.length === 0 && (
            <div className="empty-state">
              <p>No participants yet.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

interface TimelineTabProps {
  incidentId: string;
  canRead: boolean;
}

function TimelineTab({ incidentId, canRead }: TimelineTabProps): JSX.Element {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!canRead) {
      setLoading(false);
      return;
    }
    listTimeline(incidentId, { order: "asc" })
      .then((response) => setEvents(response.items))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load timeline."))
      .finally(() => setLoading(false));
  }, [incidentId, canRead]);

  if (!canRead) {
    return <p className="cell-muted">You don't have permission to view this incident's timeline.</p>;
  }

  return (
    <div className="detail-section">
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Actor</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td className="cell-muted">{new Date(event.occurredAt).toLocaleString()}</td>
                <td className="cell-primary">{event.eventType.replaceAll("_", " ")}</td>
                <td className="cell-muted">{event.actorDisplayName ?? "System"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && events.length === 0 && (
          <div className="empty-state">
            <p>No timeline events yet.</p>
          </div>
        )}
      </div>
    </div>
  );
}

const ALERT_STATUS_BADGE: Record<string, string> = {
  draft: "badge-neutral",
  ready: "badge-success",
  cancelled: "badge-warning",
  dispatching: "badge-neutral",
  submitted: "badge-success",
  partially_submitted: "badge-warning",
  submission_failed: "badge-critical",
};

interface CommandCenterTabProps {
  incidentId: string;
  canCreateAlert: boolean;
  onNavigateToAlerts?: (request: NavigateToAlertsRequest) => void;
}

/**
 * Read-only aggregation over existing Module 08-11 data — this tab never introduces a parallel
 * incident/alert/delivery status model of its own. See
 * claude/prompts/12-incident-command-center.md, "Command Center architecture".
 */
function CommandCenterTab({ incidentId, canCreateAlert, onNavigateToAlerts }: CommandCenterTabProps): JSX.Element {
  const [data, setData] = useState<CommandCenter | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setData(await getCommandCenter(incidentId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the command center.");
    }
  }, [incidentId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (error) {
    return (
      <p className="error-banner" role="alert">
        {error}
      </p>
    );
  }
  if (!data) {
    return <p>Loading…</p>;
  }

  const { alertsSummary, recentAlerts, recentTimeline } = data;

  return (
    <>
      <div className="detail-section">
        <div className="detail-section-title">Communication status</div>
        <p className="cell-primary">
          {alertsSummary.total} alert{alertsSummary.total === 1 ? "" : "s"} — {alertsSummary.draft} draft,{" "}
          {alertsSummary.ready} ready, {alertsSummary.submitted} submitted
          {alertsSummary.partiallySubmitted > 0 && `, ${alertsSummary.partiallySubmitted} partially submitted`}
          {alertsSummary.submissionFailed > 0 && `, ${alertsSummary.submissionFailed} submission failed`}
        </p>
        <p className="cell-muted">
          Delivery: {alertsSummary.delivery.delivered} delivered, {alertsSummary.delivery.deliveryPending} pending
          {alertsSummary.delivery.undelivered > 0 && `, ${alertsSummary.delivery.undelivered} undelivered`}
          {alertsSummary.delivery.bounced > 0 && `, ${alertsSummary.delivery.bounced} bounced`}
          {alertsSummary.delivery.failed > 0 && `, ${alertsSummary.delivery.failed} failed`}
        </p>
        {canCreateAlert && onNavigateToAlerts && (
          <div className="detail-actions" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => onNavigateToAlerts({ createIncidentId: incidentId })}
            >
              Create Alert for this Incident
            </button>
          </div>
        )}
      </div>

      <div className="detail-section">
        <div className="detail-section-title">Recent Alerts</div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Number</th>
                <th>Channel</th>
                <th>Status</th>
                <th>Delivery</th>
                <th>Created</th>
                {onNavigateToAlerts && <th></th>}
              </tr>
            </thead>
            <tbody>
              {recentAlerts.map((a) => (
                <tr key={a.id}>
                  <td className="cell-muted">{a.alertNumber}</td>
                  <td className="cell-muted">{a.channel.toUpperCase()}</td>
                  <td>
                    <span className={`badge ${ALERT_STATUS_BADGE[a.status] ?? "badge-neutral"}`}>{a.status}</span>
                  </td>
                  <td className="cell-muted">
                    {a.deliverySummary.delivered} delivered, {a.deliverySummary.deliveryPending} pending
                  </td>
                  <td className="cell-muted">
                    {new Date(a.createdAt).toLocaleString()}
                    {a.createdByDisplayName ? ` · ${a.createdByDisplayName}` : ""}
                  </td>
                  {onNavigateToAlerts && (
                    <td>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => onNavigateToAlerts({ alertId: a.id })}
                      >
                        View
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {recentAlerts.length === 0 && (
            <div className="empty-state">
              <p>No alerts yet for this incident.</p>
            </div>
          )}
        </div>
      </div>

      <div className="detail-section">
        <div className="detail-section-title">Recent Timeline</div>
        <div className="table-wrap">
          <table className="data-table">
            <tbody>
              {recentTimeline.map((event) => (
                <tr key={event.id}>
                  <td className="cell-muted">{new Date(event.occurredAt).toLocaleString()}</td>
                  <td className="cell-primary">{event.eventType.replaceAll("_", " ")}</td>
                  <td className="cell-muted">{event.actorDisplayName ?? "System"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {recentTimeline.length === 0 && (
            <div className="empty-state">
              <p>No timeline events yet.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
