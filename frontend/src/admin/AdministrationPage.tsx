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

      <div className="metric-grid">
        <div className="card metric-card">
          <div className="metric-label">Application</div>
          <div className="cell-primary">{status.application.name}</div>
          <div className="metric-foot">
            v{status.application.version} · {status.application.environment}
          </div>
        </div>
        <div className="card metric-card">
          <div className="metric-label">Database</div>
          <span className={`badge ${status.database.connected ? "badge-success" : "badge-critical"}`}>
            {status.database.connected ? "Connected" : "Unavailable"}
          </span>
        </div>
        <div className="card metric-card">
          <div className="metric-label">Communication Providers</div>
          <div className="metric-foot">SMS: {status.providers.sms} · Email: {status.providers.email}</div>
        </div>
        <div className="card metric-card">
          <div className="metric-label">Collaboration Provider</div>
          <span className="badge badge-neutral">Foundation only</span>
        </div>
      </div>

      <div className="card section-block">
        <div className="card-pad">
          <div className="section-heading">Security</div>
          <div className="form-grid">
            <div>
              <div className="cell-muted">MFA available</div>
              <div className="cell-primary">{status.security.mfaAvailable ? "Yes" : "No"}</div>
            </div>
            <div>
              <div className="cell-muted">Session lifetime</div>
              <div className="cell-primary">{status.security.sessionTtlHours}h</div>
            </div>
            <div>
              <div className="cell-muted">Minimum password length</div>
              <div className="cell-primary">{status.security.passwordMinLength}</div>
            </div>
            <div>
              <div className="cell-muted">Login lockout threshold</div>
              <div className="cell-primary">{status.security.loginMaxFailures} failed attempts</div>
            </div>
            <div>
              <div className="cell-muted">Break-glass account</div>
              <div className="cell-primary">
                {status.security.breakGlass.present ? `Present (${status.security.breakGlass.status})` : "Not configured"}
              </div>
            </div>
          </div>
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
