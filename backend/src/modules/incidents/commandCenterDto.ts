import type { AlertChannel, AlertStatus, DeliverySummaryDto } from "../alerts/dto.js";
import type { IncidentAlertStatusCounts } from "../alerts/alertQueries.js";
import type { DeliverySummaryCounts } from "../notifications/deliveryQueries.js";
import type { IncidentDto, TimelineEventDto } from "./dto.js";

export interface ParticipantsSummaryDto {
  total: number;
  registeredUsers: number;
  contacts: number;
}

/** Same safe aggregate shape Module 11 already exposes per-Alert — reused, not reinvented. */
export interface AlertsSummaryDto extends IncidentAlertStatusCounts {
  delivery: DeliverySummaryCounts;
}

/** A recent-Alert card — safe summary fields only, never recipient destination PII. */
export interface RecentAlertDto {
  id: string;
  alertNumber: string;
  title: string;
  channel: AlertChannel;
  status: AlertStatus;
  createdByDisplayName: string | null;
  createdAt: string;
  updatedAt: string;
  deliverySummary: DeliverySummaryDto;
}

export interface CommandCenterDto {
  incident: IncidentDto;
  participantsSummary: ParticipantsSummaryDto;
  alertsSummary: AlertsSummaryDto;
  recentAlerts: RecentAlertDto[];
  recentTimeline: TimelineEventDto[];
}
