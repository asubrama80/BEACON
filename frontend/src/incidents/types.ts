export type IncidentSeverity = "info" | "warning" | "high" | "critical";
export type IncidentStatus = "open" | "active" | "resolved" | "closed";
export type ParticipantType = "user" | "contact";

export interface CommanderSummary {
  id: string;
  displayName: string;
  status: string;
}

export interface Incident {
  id: string;
  incidentNumber: string;
  title: string;
  description: string | null;
  severity: IncidentSeverity;
  status: IncidentStatus;
  commander: CommanderSummary | null;
  participantCount: number;
  registeredUserCount: number;
  contactParticipantCount: number;
  activatedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentsListResponse {
  items: Incident[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Participant {
  id: string;
  participantType: ParticipantType;
  participantRole: string;
  status: string;
  displayName: string;
  email: string | null;
  mobilePhone: string | null;
  sourceStatus: string;
  addedAt: string;
}

export interface ParticipantsListResponse {
  items: Participant[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TimelineEvent {
  id: string;
  eventType: string;
  actorUserId: string | null;
  actorDisplayName: string | null;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface TimelineListResponse {
  items: TimelineEvent[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ParticipantsSummary {
  total: number;
  registeredUsers: number;
  contacts: number;
}

export interface DeliverySummaryCounts {
  total: number;
  submissionFailed: number;
  deliveryPending: number;
  delivered: number;
  undelivered: number;
  bounced: number;
  failed: number;
}

/** `submissionFailed` here counts Alerts whose own status is submission_failed — distinct from
 * `delivery.submissionFailed`, which counts individual recipients whose submission failed. */
export interface AlertsSummary {
  total: number;
  draft: number;
  ready: number;
  dispatching: number;
  submitted: number;
  partiallySubmitted: number;
  submissionFailed: number;
  cancelled: number;
  delivery: DeliverySummaryCounts;
}

export interface RecentAlert {
  id: string;
  alertNumber: string;
  title: string;
  channel: "sms" | "email";
  status: string;
  createdByDisplayName: string | null;
  createdAt: string;
  updatedAt: string;
  deliverySummary: {
    total: number;
    submissionFailed: number;
    deliveryPending: number;
    delivered: number;
    undelivered: number;
    bounced: number;
    failed: number;
    overallStatus: "pending" | "in_progress" | "complete" | "partial_failure" | "failed";
    deliveryCompletedAt: string | null;
  };
}

export interface CommandCenter {
  incident: Incident;
  participantsSummary: ParticipantsSummary;
  alertsSummary: AlertsSummary;
  recentAlerts: RecentAlert[];
  recentTimeline: TimelineEvent[];
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}
