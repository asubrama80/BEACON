import type { Database } from "@beacon/database";
import { getIncidentStatusCounts, listIncidents as queryIncidentsList } from "../incidents/incidentQueries.js";
import { toIncidentDto } from "../incidents/dto.js";
import { getGlobalAlertStatusCounts, listAlerts as queryAlertsList, normalizePagination as normalizeAlertPagination } from "../alerts/alertQueries.js";
import { getGlobalDeliverySummary } from "../notifications/deliveryQueries.js";
import { getAlert as getAlertDetail } from "../alerts/service.js";
import { listContacts as queryContactsList } from "../contacts/contactQueries.js";
import { listGroups as queryGroupsList } from "../groups/groupQueries.js";
import { toRecentIncidentDto, type DashboardDto } from "./dashboardDto.js";
import type { RecentAlertDto } from "../incidents/commandCenterDto.js";

const RECENT_INCIDENTS_LIMIT = 5;
const RECENT_ALERTS_LIMIT = 5;

/**
 * Assembles the Dashboard's aggregate, read-only projection entirely from existing authoritative
 * sources (Modules 04/06/08/09/10/11) — the same "never a parallel status model" discipline
 * Module 12's Command Center already established, just at the platform level instead of one
 * Incident. See claude/prompts/21-dashboard-history.md, "Authoritative data sources".
 */
export async function getDashboard(db: Database): Promise<DashboardDto> {
  const [incidentStatusCounts, recentIncidentsPage, alertStatusCounts, deliverySummary, recentAlertsPage, activeContacts, activeGroups] =
    await Promise.all([
      getIncidentStatusCounts(db),
      queryIncidentsList(db, { page: 1, pageSize: RECENT_INCIDENTS_LIMIT }),
      getGlobalAlertStatusCounts(db),
      getGlobalDeliverySummary(db),
      queryAlertsList(db, { ...normalizeAlertPagination(1, RECENT_ALERTS_LIMIT) }),
      queryContactsList(db, { status: "active", page: 1, pageSize: 1 }),
      queryGroupsList(db, { status: "active", page: 1, pageSize: 1 }),
    ]);

  // Bounded fan-out (at most RECENT_ALERTS_LIMIT) — reuses the existing per-Alert service
  // function rather than reimplementing delivery-summary math a second time, exactly mirroring
  // Module 12's Command Center `recentAlerts` construction.
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
    incidents: {
      ...incidentStatusCounts,
      recent: recentIncidentsPage.items.map(toIncidentDto).map(toRecentIncidentDto),
    },
    alerts: {
      ...alertStatusCounts,
      delivery: deliverySummary,
      recent: recentAlerts,
    },
    contacts: { active: activeContacts.total },
    groups: { active: activeGroups.total },
    attention: {
      readyAlertsNotDispatched: alertStatusCounts.ready,
      deliveryFailures: deliverySummary.submissionFailed + deliverySummary.undelivered + deliverySummary.bounced + deliverySummary.failed,
    },
  };
}
