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

export interface ApiErrorBody {
  error?: string;
  message?: string;
}
