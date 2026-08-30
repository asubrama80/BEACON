import type { Database } from "@beacon/database";
import { findIncidentById } from "./incidentQueries.js";
import { AuthError } from "../auth/errors.js";
import { toIncidentDto, toTimelineEventDto } from "./dto.js";
import { listTimeline as queryTimeline } from "./timelineQueries.js";
import { getIncidentAlertStatusCounts } from "../alerts/alertQueries.js";
import { getIncidentDeliverySummary } from "../notifications/deliveryQueries.js";
import { listAlerts as queryAlerts, normalizePagination as normalizeAlertPagination } from "../alerts/alertQueries.js";
import { getAlert as getAlertDetail } from "../alerts/service.js";
import type { CommandCenterDto, RecentAlertDto } from "./commandCenterDto.js";

const RECENT_ALERTS_LIMIT = 5;
const RECENT_TIMELINE_LIMIT = 10;

/**
 * Assembles the Command Center's aggregate, read-only projection entirely from existing
 * authoritative sources (Modules 08-11) — never a parallel incident/alert/delivery status model.
 * See claude/prompts/12-incident-command-center.md, "Command Center architecture".
 */
export async function getCommandCenter(db: Database, incidentId: string): Promise<CommandCenterDto> {
  const incidentRow = await findIncidentById(db, incidentId);
  if (!incidentRow) {
    throw new AuthError(404, "not_found", "Incident not found.");
  }
  const incident = toIncidentDto(incidentRow);

  const [alertStatusCounts, deliveryRollup, recentAlertsPage, timelinePage] = await Promise.all([
    getIncidentAlertStatusCounts(db, incidentId),
    getIncidentDeliverySummary(db, incidentId),
    queryAlerts(db, { incidentId, ...normalizeAlertPagination(1, RECENT_ALERTS_LIMIT) }),
    queryTimeline(db, incidentId, { page: 1, pageSize: RECENT_TIMELINE_LIMIT, order: "desc" }),
  ]);

  // Bounded fan-out (at most RECENT_ALERTS_LIMIT) — reuses the existing per-Alert service
  // function rather than reimplementing delivery-summary math a second time. See module doc,
  // "Alert communication summary".
  const recentAlerts: RecentAlertDto[] = await Promise.all(
    recentAlertsPage.items.map(async (row): Promise<RecentAlertDto> => {
      const detail = await getAlertDetail(db, row.id);
      return {
        id: detail.id,
        alertNumber: detail.alertNumber,
        title: detail.title,
        channel: detail.channel,
        status: detail.status,
        createdByDisplayName: detail.createdByDisplayName,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt,
        deliverySummary: detail.deliverySummary,
      };
    }),
  );

  return {
    incident,
    participantsSummary: {
      total: incident.participantCount,
      registeredUsers: incident.registeredUserCount,
      contacts: incident.contactParticipantCount,
    },
    alertsSummary: { ...alertStatusCounts, delivery: deliveryRollup },
    recentAlerts,
    recentTimeline: timelinePage.items.map(toTimelineEventDto),
  };
}
