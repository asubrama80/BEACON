import { useCallback, useEffect, useState } from "react";
import { getAdminStatus, listRoleSummaries } from "./api";
import type { AdminStatus, RoleSummary } from "./types";

interface AdministrationPageProps {
  onNavigateToUsers?: () => void;
  onNavigateToAudit?: () => void;
}

/** Maps a permission code's leading segment (e.g. "incidents.chat.read" → "incidents") to a
 * display group label. Purely cosmetic grouping — never renames the underlying codes. See
 * claude/prompts/22-administration.md, "Roles & permissions display". */
const GROUP_LABELS: Record<string, string> = {
  admin: "Administration",
  audit: "Audit",
  alerts: "Alerts",
  contacts: "Contacts",
  groups: "Groups",
  templates: "Templates",
  incidents: "Incidents",
  users: "Authentication / Users",
  roles: "Authentication / Users",
  permissions: "Authentication / Users",
};

function groupPermissions(codes: string[]): Array<{ label: string; codes: string[] }> {
  const byGroup = new Map<string, string[]>();
  for (const code of codes) {
    const prefix = code.split(".")[0]!;
    const label = GROUP_LABELS[prefix] ?? prefix;
    if (!byGroup.has(label)) byGroup.set(label, []);
    byGroup.get(label)!.push(code);
  }
  return [...byGroup.entries()]
    .map(([label, groupCodes]) => ({ label, codes: groupCodes.sort() }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Application Administration — system/security status, provider names (read-only, never
 * credentials — see Module 27's boundary), and role-to-permission visibility. User management and
 * Audit are deliberately not duplicated here; this page links to those existing pages instead.
 * See claude/prompts/22-administration.md.
 */
export default function AdministrationPage({ onNavigateToUsers, onNavigateToAudit }: AdministrationPageProps): JSX.Element {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [roleSummaries, setRoleSummaries] = useState<RoleSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [statusResult, rolesResult] = await Promise.all([getAdminStatus(), listRoleSummaries()]);
      setStatus(statusResult);
      setRoleSummaries(rolesResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load Administration.");
    }
  }, []);

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
  if (!status) {
    return <p>Loading…</p>;
  }

  return (
    <div className="admin-page">
      <h2 className="page-heading">Administration</h2>
      <p className="page-lede">Application configuration, security posture, and role visibility.</p>

      <div className="admin-grid section-block">
        <div className="card card-pad">
          <div className="admin-section-title">System</div>
          <div className="kv-row">
            <span className="kv-k">Application</span>
            <span className="kv-v">{status.application.name}</span>
          </div>
          <div className="kv-row">
            <span className="kv-k">Version</span>
            <span className="kv-v mono">{status.application.version}</span>
          </div>
          <div className="kv-row">
            <span className="kv-k">Environment</span>
            <span className="kv-v">{status.application.environment}</span>
          </div>
          <div className="kv-row">
            <span className="kv-k">Database</span>
            <span className={`status-pill ${status.database.connected ? "status-connected" : "status-failed"}`}>
              {status.database.connected ? "Connected" : "Unavailable"}
            </span>
          </div>
        </div>

        <div className="card card-pad">
          <div className="admin-section-title">Communication Providers</div>
          <div className="kv-row">
            <span className="kv-k">SMS Provider — {status.providers.sms}</span>
            <span className="status-pill status-connected">Configured</span>
          </div>
          <div className="kv-row">
            <span className="kv-k">Email Provider — {status.providers.email}</span>
            <span className="status-pill status-connected">Configured</span>
          </div>
        </div>

        <div className="card card-pad">
          <div className="admin-section-title">Authentication &amp; Security</div>
          <div className="kv-row">
            <span className="kv-k">Local MFA</span>
            <span className="status-pill status-connected">{status.security.mfaAvailable ? "Available" : "Unavailable"}</span>
          </div>
          <div className="kv-row">
            <span className="kv-k">Session lifetime</span>
            <span className="kv-v">{status.security.sessionTtlHours}h</span>
          </div>
          <div className="kv-row">
            <span className="kv-k">Minimum password length</span>
            <span className="kv-v">{status.security.passwordMinLength}</span>
          </div>
          <div className="kv-row">
            <span className="kv-k">Login lockout threshold</span>
            <span className="kv-v">{status.security.loginMaxFailures} failed attempts</span>
          </div>
          <div className="kv-row">
            <span className="kv-k">Break-glass account</span>
            <span className="kv-v">
              {status.security.breakGlass.present ? `Present (${status.security.breakGlass.status})` : "Not configured"}
            </span>
          </div>
        </div>

        <div className="card card-pad">
          <div className="admin-section-title">Collaboration Provider</div>
          <div className="kv-row">
            <span className="kv-k">Realtime Collaboration</span>
            <span className="status-pill status-pending">Foundation only</span>
          </div>
          <p className="section-sub" style={{ marginTop: 10, lineHeight: 1.5 }}>
            BEACON uses a provider-independent collaboration layer. Audio/video and screen sharing
            are not yet implemented.
          </p>
        </div>
      </div>

      <div className="card section-block">
        <div className="card-pad">
          <div className="flex-between" style={{ marginBottom: 16 }}>
            <div>
              <div className="section-heading">Roles &amp; Permissions</div>
              <div className="section-sub">Seed-managed roles — read-only view of what each role can do.</div>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Users</th>
                  <th>Permissions</th>
                </tr>
              </thead>
              <tbody>
                {roleSummaries.map((role) => (
                  <tr key={role.id}>
                    <td className="cell-primary">
                      {role.name}
                      <div className="cell-muted mono" style={{ fontSize: 11 }}>
                        {role.code}
                      </div>
                    </td>
                    <td className="cell-muted mono">{role.userCount}</td>
                    <td>
                      {groupPermissions(role.permissionCodes).map((group) => (
                        <div key={group.label} style={{ marginBottom: 4 }}>
                          <span className="cell-muted" style={{ fontSize: 11 }}>
                            {group.label}:{" "}
                          </span>
                          {group.codes.map((code) => (
                            <span key={code} className="permission-chip">
                              {code}
                            </span>
                          ))}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {(onNavigateToUsers || onNavigateToAudit) && (
        <div className="card section-block">
          <div className="card-pad">
            <div className="section-heading">Related</div>
            <div className="form-actions" style={{ justifyContent: "flex-start", gap: 12 }}>
              {onNavigateToUsers && (
                <button type="button" className="link-btn" onClick={onNavigateToUsers}>
                  Manage Users →
                </button>
              )}
              {onNavigateToAudit && (
                <button type="button" className="link-btn" onClick={onNavigateToAudit}>
                  View Audit →
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
