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

/** Post-submission delivery-tracking summary — safe aggregate counts only, never per-recipient. */
export interface DeliverySummary {
  total: number;
  submissionFailed: number;
  deliveryPending: number;
  delivered: number;
  undelivered: number;
  bounced: number;
  failed: number;
  overallStatus: "pending" | "in_progress" | "complete" | "partial_failure" | "failed";
  deliveryCompletedAt: string | null;
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
  deliverySummary: DeliverySummary;
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
  /** Post-submission delivery tracking (Module 11) — meaningful only once status = 'submitted'. */
  deliveryStatus: string | null;
  deliveryUpdatedAt: string | null;
  deliveredAt: string | null;
  providerDeliveryCode: string | null;
  deliveryErrorSummary: string | null;
  createdAt: string;
}

export interface AlertRecipientsListResponse {
  items: AlertRecipient[];
  total: number;
  page: number;
  pageSize: number;
}

/** A single normalized delivery event from the recipient's event history — never destination PII. */
export interface DeliveryEvent {
  id: string;
  provider: string;
  providerMessageId: string;
  providerEventId: string | null;
  rawProviderStatus: string;
  normalizedStatus: string;
  occurredAt: string;
  receivedAt: string;
  providerErrorCode: string | null;
  safeErrorSummary: string | null;
}

export type MockDeliveryStatus = "delivered" | "undelivered" | "bounced" | "failed";

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
