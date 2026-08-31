export interface RecentIncident {
  id: string;
  incidentNumber: string;
  title: string;
  severity: string;
  status: string;
  updatedAt: string;
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

export interface RecentAlert {
  id: string;
  alertNumber: string;
  title: string;
  channel: "sms" | "email";
  status: string;
  createdByDisplayName: string | null;
  createdAt: string;
  updatedAt: string;
  deliverySummary: DeliverySummaryCounts & {
    overallStatus: "pending" | "in_progress" | "complete" | "partial_failure" | "failed";
    deliveryCompletedAt: string | null;
  };
}

export interface DashboardData {
  incidents: {
    total: number;
    open: number;
    active: number;
    resolved: number;
    closed: number;
    recent: RecentIncident[];
  };
  alerts: {
    total: number;
    draft: number;
    ready: number;
    dispatching: number;
    submitted: number;
    partiallySubmitted: number;
    submissionFailed: number;
    cancelled: number;
    delivery: DeliverySummaryCounts;
    recent: RecentAlert[];
  };
  contacts: { active: number };
  groups: { active: number };
  attention: {
    readyAlertsNotDispatched: number;
    deliveryFailures: number;
  };
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}
