export type AlertChannel = "sms" | "email";
export type AlertStatus =
  | "draft"
  | "ready"
  | "cancelled"
  | "dispatching"
  | "submitted"
  | "partially_submitted"
  | "submission_failed";
export type AlertContentSource = "template" | "adhoc";

export interface IncidentSummaryRef {
  id: string;
  incidentNumber: string;
  title: string;
  status: string;
}

export interface TemplateSummaryRef {
  id: string;
  name: string;
  status: string;
}

export interface AlertSummary {
  id: string;
  alertNumber: string;
  title: string;
  incident: IncidentSummaryRef | null;
  channel: AlertChannel;
  status: AlertStatus;
  contentSource: AlertContentSource;
  eligibleRecipientCount: number | null;
  excludedCount: number | null;
  createdByDisplayName: string | null;
  createdAt: string;
  updatedAt: string;
  readyAt: string | null;
  cancelledAt: string | null;
}

export interface SourceContactRef {
  id: string;
  displayName: string;
}

export interface SourceGroupRef {
  id: string;
  name: string;
}

export interface AlertDetail extends AlertSummary {
  template: TemplateSummaryRef | null;
  templateNameSnapshot: string | null;
  subject: string | null;
  body: string | null;
  exclusionSummary: Record<string, number> | null;
  sourceContactCount: number;
  sourceGroupCount: number;
  sourceContacts: SourceContactRef[];
  sourceGroups: SourceGroupRef[];
  submittedCount: number;
  submissionFailedCount: number;
  pendingDispatchCount: number;
}

export interface AlertsListResponse {
  items: AlertSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AlertPreview {
  channel: AlertChannel;
  uniqueRecipientCount: number;
  eligibleCount: number;
  excludedCount: number;
  exclusionSummary: Record<string, number>;
  duplicatesCollapsedCount: number;
  invalidGroupIds: string[];
  zeroRecipientWarning: boolean;
  templateActive: boolean | null;
  sampleRenderedSubject?: string;
  sampleRenderedBody: string;
  sms?: { encoding: "GSM-7" | "UCS-2"; characterCount: number; gsmUnitCount: number | null; segmentCount: number };
}

export interface AlertRecipient {
  id: string;
  contactId: string | null;
  displayName: string | null;
  destination: string | null;
  channel: AlertChannel;
  renderedSubject: string | null;
  renderedBody: string | null;
  status: string;
  provider: string | null;
  providerMessageId: string | null;
  attemptCount: number;
  lastFailureClass: string | null;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  submittedAt: string | null;
  failedAt: string | null;
  createdAt: string;
}

export interface AlertRecipientsListResponse {
  items: AlertRecipient[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DispatchSummary {
  alertId: string;
  status: AlertStatus;
  totalRecipients: number;
  submitted: number;
  submissionFailed: number;
  pending: number;
}

export interface ProviderStatus {
  sms: { provider: string; configured: boolean };
  email: { provider: string; configured: boolean };
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}
