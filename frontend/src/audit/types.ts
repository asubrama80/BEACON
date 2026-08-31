export interface AuditActor {
  type: "user" | "guest" | "contact" | "system";
  id: string | null;
  displayName: string | null;
}

export interface AuditResource {
  type: string | null;
  id: string | null;
}

export interface AuditEvent {
  id: string;
  timestamp: string;
  eventType: string;
  actor: AuditActor;
  resource: AuditResource;
  incidentId: string | null;
  metadata: Record<string, unknown>;
}

export interface AuditSearchResponse {
  items: AuditEvent[];
  nextCursor: string | null;
}

export interface AuditFilters {
  eventType?: string;
  actorType?: string;
  from?: string;
  to?: string;
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}
