import type { IncidentStatusCounts } from "../incidents/incidentQueries.js";
import type { AlertsSummaryDto, RecentAlertDto } from "../incidents/commandCenterDto.js";
import type { IncidentDto } from "../incidents/dto.js";

/** A recent-Incident card — the same safe fields the Incidents list already exposes. */
export interface RecentIncidentDto {
  id: string;
  incidentNumber: string;
  title: string;
  severity: string;
  status: string;
  updatedAt: string;
}

/**
 * Deterministic, explainable "needs attention" counts — never a fabricated severity score. See
 * claude/prompts/21-dashboard-history.md, "Attention Required".
 */
export interface AttentionDto {
  /** Alerts sitting in READY but not yet dispatched. */
  readyAlertsNotDispatched: number;
  /** Global submission + delivery failure count (submissionFailed + undelivered + bounced + failed). */
  deliveryFailures: number;
}

export interface DashboardDto {
  incidents: IncidentStatusCounts & { recent: RecentIncidentDto[] };
  alerts: AlertsSummaryDto & { recent: RecentAlertDto[] };
  contacts: { active: number };
  groups: { active: number };
  attention: AttentionDto;
}

export function toRecentIncidentDto(incident: IncidentDto): RecentIncidentDto {
  return {
    id: incident.id,
    incidentNumber: incident.incidentNumber,
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    updatedAt: incident.updatedAt,
  };
}
