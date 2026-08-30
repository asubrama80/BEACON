import { useCallback, useEffect, useState } from "react";
import Modal from "../components/Modal";
import { cancelAlert, dispatchAlert, getAlert, getProviderStatus, previewAlert, readyAlert, updateAlert } from "./api";
import type { AlertDetail, AlertPreview, ProviderStatus } from "./types";
import { listContacts } from "../contacts/api";
import type { Contact } from "../contacts/types";
import { listGroups } from "../groups/api";
import type { Group } from "../groups/types";
import { useAuth } from "../auth/useAuth";

interface AlertDetailModalProps {
  alertId: string;
  onClose: () => void;
  onChanged: () => void;
}

type Tab = "overview" | "audience";

const STATUS_BADGE: Record<string, string> = {
  draft: "badge-neutral",
  ready: "badge-success",
  cancelled: "badge-warning",
  dispatching: "badge-neutral",
  submitted: "badge-success",
  partially_submitted: "badge-warning",
  submission_failed: "badge-critical",
};

const STATUS_LABEL: Record<string, string> = {
  partially_submitted: "partially submitted",
  submission_failed: "submission failed",
};

export default function AlertDetailModal({ alertId, onClose, onChanged }: AlertDetailModalProps): JSX.Element {
  const { user } = useAuth();
  const canUpdate = user?.permissions.includes("alerts.update") ?? false;
  const canReady = user?.permissions.includes("alerts.ready") ?? false;
  const canCancel = user?.permissions.includes("alerts.cancel") ?? false;
  const canDispatch = user?.permissions.includes("alerts.dispatch") ?? false;

  const [tab, setTab] = useState<Tab>("overview");
  const [alert, setAlert] = useState<AlertDetail | null>(null);
  const [title, setTitle] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<AlertPreview | null>(null);
  const [confirmingReady, setConfirmingReady] = useState(false);
  const [confirmingDispatch, setConfirmingDispatch] = useState(false);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | null>(null);

  const isDraft = alert?.status === "draft";
  const isReady = alert?.status === "ready";
  const hasSubmissionActivity = !!alert && (alert.submittedCount > 0 || alert.submissionFailedCount > 0);

  const refresh = useCallback(async () => {
    const fresh = await getAlert(alertId);
    setAlert(fresh);
    setTitle(fresh.title);
    setSubject(fresh.subject ?? "");
    setBody(fresh.body ?? "");
    onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertId]);

  useEffect(() => {
    refresh().catch((err: unknown) => setError(err instanceof Error ? err.message : "Unable to load alert."));
  }, [refresh]);

  async function saveDetails(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const patch: Parameters<typeof updateAlert>[1] = { title };
      if (alert?.contentSource === "adhoc") {
        patch.subject = subject;
        patch.body = body;
      }
      await updateAlert(alertId, patch);
      setPreview(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update alert.");
    } finally {
      setBusy(false);
    }
  }

  async function runPreview(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setPreview(await previewAlert(alertId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to preview this alert.");
    } finally {
      setBusy(false);
    }
  }

  async function confirmReady(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await readyAlert(alertId);
      setConfirmingReady(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to mark this alert ready.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCancel(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await cancelAlert(alertId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to cancel this alert.");
    } finally {
      setBusy(false);
    }
  }

  async function openDispatchConfirmation(): Promise<void> {
    setError(null);
    try {
      setProviderStatus(await getProviderStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load provider status.");
      return;
    }
    setConfirmingDispatch(true);
  }

  async function confirmDispatch(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await dispatchAlert(alertId);
      setConfirmingDispatch(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to dispatch this alert.");
    } finally {
      setBusy(false);
    }
  }

  if (!alert) {
    return (
      <Modal title="Alert" onClose={onClose}>
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
    <Modal title={`${alert.alertNumber} — ${alert.title}`} onClose={onClose}>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}

      <div className="detail-section">
        <span className={`badge ${STATUS_BADGE[alert.status] ?? "badge-neutral"}`}>
          {STATUS_LABEL[alert.status] ?? alert.status}
        </span>
        <span className="cell-muted" style={{ marginLeft: 12 }}>
          {alert.channel.toUpperCase()} · {alert.incident ? alert.incident.incidentNumber : "Standalone"}
        </span>
        {alert.status === "ready" && (
          <span className="cell-muted" style={{ marginLeft: 12 }}>
            {alert.eligibleRecipientCount} eligible, {alert.excludedCount} excluded
          </span>
        )}
      </div>

      {isReady && !hasSubmissionActivity && (
        <p className="warning-banner">
          This alert is READY. Its content and recipient snapshot are frozen. It has not been dispatched to a
          notification provider yet.
        </p>
      )}
      {alert.status === "cancelled" && <p className="warning-banner">This alert has been cancelled.</p>}

      {hasSubmissionActivity && (
        <div className="detail-section">
          <div className="detail-section-title">Submission</div>
          <p className="cell-primary">
            {alert.submittedCount} submitted
            {alert.submissionFailedCount > 0 && `, ${alert.submissionFailedCount} submission failed`}
            {alert.pendingDispatchCount > 0 && `, ${alert.pendingDispatchCount} pending`}
          </p>
          <p className="cell-muted">
            "Submitted" means the notification provider accepted the message — it does not confirm the recipient
            received it.
          </p>
        </div>
      )}

      <div className="tab-row" style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <button
          type="button"
          className={`btn btn-sm ${tab === "overview" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          type="button"
          className={`btn btn-sm ${tab === "audience" ? "btn-primary" : "btn-secondary"}`}
          onClick={() => setTab("audience")}
        >
          Audience
        </button>
      </div>

      {tab === "overview" && (
        <>
          <div className="detail-section">
            <div className="detail-section-title">Details</div>
            <div className="form-grid">
              <label className="form-field">
                <span className="form-label">Title</span>
                <input
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={!isDraft || !canUpdate}
                />
              </label>

              {alert.contentSource === "template" ? (
                <div className="form-field">
                  <span className="form-label">Template</span>
                  <span className="cell-primary">{alert.templateNameSnapshot ?? alert.template?.name ?? "—"}</span>
                </div>
              ) : (
                <>
                  {alert.channel === "email" && (
                    <label className="form-field">
                      <span className="form-label">Subject</span>
                      <input
                        className="input"
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        disabled={!isDraft || !canUpdate}
                      />
                    </label>
                  )}
                  <label className="form-field">
                    <span className="form-label">Message body</span>
                    <textarea
                      className="input"
                      style={{ height: 90, paddingTop: 8 }}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      disabled={!isDraft || !canUpdate}
                    />
                  </label>
                </>
              )}

              {isDraft && canUpdate && (
                <div className="form-actions">
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void saveDetails()}>
                    Save details
                  </button>
                </div>
              )}
            </div>
          </div>

          {isDraft && (
            <div className="detail-section">
              <div className="detail-section-title">Preview &amp; Ready</div>
              <div className="detail-actions">
                {canUpdate && (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void runPreview()}>
                    Preview audience &amp; content
                  </button>
                )}
                {canReady && !confirmingReady && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => setConfirmingReady(true)}>
                    Mark Ready
                  </button>
                )}
              </div>

              {preview && (
                <div className="card" style={{ marginTop: 12, padding: 14 }}>
                  <p className="cell-primary">
                    {preview.eligibleCount} eligible recipient{preview.eligibleCount === 1 ? "" : "s"}
                    {preview.excludedCount > 0 && `, ${preview.excludedCount} excluded`}
                  </p>
                  {preview.duplicatesCollapsedCount > 0 && (
                    <p className="cell-muted">{preview.duplicatesCollapsedCount} duplicate selection(s) collapsed.</p>
                  )}
                  {preview.excludedCount > 0 && (
                    <p className="cell-muted">
                      Excluded: {preview.exclusionSummary.inactive ?? 0} inactive, {preview.exclusionSummary.missing_channel ?? 0} missing{" "}
                      {alert.channel === "sms" ? "mobile phone" : "email"}.
                    </p>
                  )}
                  {preview.invalidGroupIds.length > 0 && (
                    <p className="cell-muted">{preview.invalidGroupIds.length} selected Group(s) are no longer active.</p>
                  )}
                  {preview.zeroRecipientWarning && (
                    <p className="error-banner" role="alert" style={{ marginTop: 8 }}>
                      0 eligible recipients — cannot continue.
                    </p>
                  )}
                  <div className="detail-section-title" style={{ marginTop: 10 }}>
                    Sample rendered content
                  </div>
                  {preview.sampleRenderedSubject && <p className="cell-primary">{preview.sampleRenderedSubject}</p>}
                  <p className="cell-muted">{preview.sampleRenderedBody}</p>
                  {preview.sms && (
                    <p className="cell-muted">
                      {preview.sms.segmentCount} SMS segment{preview.sms.segmentCount === 1 ? "" : "s"} ({preview.sms.encoding})
                    </p>
                  )}
                </div>
              )}

              {confirmingReady && (
                <div className="card" style={{ marginTop: 12, padding: 14 }}>
                  <p className="cell-primary">Confirm: mark this alert READY?</p>
                  <p className="cell-muted">
                    Channel: {alert.channel.toUpperCase()} · {alert.incident ? `Incident ${alert.incident.incidentNumber}` : "Standalone"} ·{" "}
                    {alert.sourceContactCount} direct contact(s), {alert.sourceGroupCount} group(s) selected.
                  </p>
                  <p className="cell-muted">
                    This freezes the recipient list and message content. Actual delivery is not implemented yet.
                  </p>
                  <div className="form-actions">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingReady(false)}>
                      Cancel
                    </button>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void confirmReady()}>
                      Confirm Ready
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {isReady && canDispatch && (
            <div className="detail-section">
              <div className="detail-section-title">Dispatch</div>
              {!confirmingDispatch ? (
                <div className="detail-actions">
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void openDispatchConfirmation()}>
                    Dispatch Alert
                  </button>
                </div>
              ) : (
                <div className="card" style={{ padding: 14 }}>
                  <p className="cell-primary">
                    You are about to submit this {alert.channel.toUpperCase()} alert to {alert.eligibleRecipientCount}{" "}
                    recipient{alert.eligibleRecipientCount === 1 ? "" : "s"}.
                  </p>
                  <p className="cell-muted">
                    {alert.title} · {alert.incident ? `Incident ${alert.incident.incidentNumber}` : "Standalone"}
                  </p>
                  {providerStatus && (
                    <p className={providerStatus.sms.provider === "mock" || providerStatus.email.provider === "mock" ? "cell-muted" : "warning-banner"}>
                      {alert.channel === "sms"
                        ? `Provider: ${providerStatus.sms.provider === "mock" ? "Mock / Development — no external SMS will be sent." : `${providerStatus.sms.provider} — this will send a real message.`}`
                        : `Provider: ${providerStatus.email.provider === "mock" ? "Mock / Development — no external email will be sent." : `${providerStatus.email.provider} — this will send a real message.`}`}
                    </p>
                  )}
                  <div className="form-actions">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingDispatch(false)}>
                      Cancel
                    </button>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void confirmDispatch()}>
                      Confirm Dispatch
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {(isDraft || isReady) && canCancel && (
            <div className="detail-section">
              <div className="detail-actions">
                <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void handleCancel()}>
                  Cancel Alert
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {tab === "audience" && (
        <AudienceTab alert={alert} canManage={isDraft && canUpdate} onSaved={() => void refresh().then(() => setPreview(null))} />
      )}
    </Modal>
  );
}

interface AudienceTabProps {
  alert: AlertDetail;
  canManage: boolean;
  onSaved: () => void;
}

function AudienceTab({ alert, canManage, onSaved }: AudienceTabProps): JSX.Element {
  const [contactIds, setContactIds] = useState<Set<string>>(new Set(alert.sourceContacts.map((c) => c.id)));
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set(alert.sourceGroups.map((g) => g.id)));
  const [contactNames, setContactNames] = useState<Map<string, string>>(
    new Map(alert.sourceContacts.map((c) => [c.id, c.displayName])),
  );
  const [groupNames, setGroupNames] = useState<Map<string, string>>(new Map(alert.sourceGroups.map((g) => [g.id, g.name])));

  const [contactSearch, setContactSearch] = useState("");
  const [contactResults, setContactResults] = useState<Contact[]>([]);
  const [groupSearch, setGroupSearch] = useState("");
  const [groupResults, setGroupResults] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function searchGroups(): Promise<void> {
    if (!groupSearch.trim()) {
      setGroupResults([]);
      return;
    }
    try {
      const response = await listGroups({ search: groupSearch, status: "active" });
      setGroupResults(response.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to search groups.");
    }
  }

  function addContact(c: Contact): void {
    setContactIds((prev) => new Set(prev).add(c.id));
    setContactNames((prev) => new Map(prev).set(c.id, c.displayName));
    setContactResults([]);
    setContactSearch("");
  }

  function addGroup(g: Group): void {
    setGroupIds((prev) => new Set(prev).add(g.id));
    setGroupNames((prev) => new Map(prev).set(g.id, g.name));
    setGroupResults([]);
    setGroupSearch("");
  }

  function removeContact(id: string): void {
    setContactIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function removeGroup(id: string): void {
    setGroupIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function saveAudience(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await updateAlert(alert.id, { contactIds: [...contactIds], groupIds: [...groupIds] });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update audience.");
    } finally {
      setBusy(false);
    }
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
          <div className="detail-section-title">Add Contacts</div>
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
                      <td>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => addContact(c)} disabled={contactIds.has(c.id)}>
                          {contactIds.has(c.id) ? "Added" : "Add"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="detail-section-title" style={{ marginTop: 16 }}>
            Add Groups
          </div>
          <div className="filter-row" style={{ marginBottom: 0 }}>
            <div className="search-field">
              <input
                className="input"
                placeholder="Search active groups"
                value={groupSearch}
                onChange={(e) => setGroupSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void searchGroups();
                  }
                }}
              />
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void searchGroups()}>
              Search
            </button>
          </div>
          {groupResults.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <tbody>
                  {groupResults.map((g) => (
                    <tr key={g.id}>
                      <td className="cell-primary">{g.name}</td>
                      <td className="cell-muted">{g.activeMemberCount} active members</td>
                      <td>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => addGroup(g)} disabled={groupIds.has(g.id)}>
                          {groupIds.has(g.id) ? "Added" : "Add"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="detail-section">
        <div className="detail-section-title">Selected Contacts ({contactIds.size})</div>
        <div className="table-wrap">
          <table className="data-table">
            <tbody>
              {[...contactIds].map((id) => (
                <tr key={id}>
                  <td className="cell-primary">{contactNames.get(id) ?? id}</td>
                  {canManage && (
                    <td>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeContact(id)}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {contactIds.size === 0 && (
            <div className="empty-state">
              <p>No direct contacts selected.</p>
            </div>
          )}
        </div>
      </div>

      <div className="detail-section">
        <div className="detail-section-title">Selected Groups ({groupIds.size})</div>
        <div className="table-wrap">
          <table className="data-table">
            <tbody>
              {[...groupIds].map((id) => (
                <tr key={id}>
                  <td className="cell-primary">{groupNames.get(id) ?? id}</td>
                  {canManage && (
                    <td>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeGroup(id)}>
                        Remove
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {groupIds.size === 0 && (
            <div className="empty-state">
              <p>No groups selected.</p>
            </div>
          )}
        </div>
      </div>

      {canManage && (
        <div className="form-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void saveAudience()}>
            Save audience
          </button>
        </div>
      )}
    </>
  );
}
