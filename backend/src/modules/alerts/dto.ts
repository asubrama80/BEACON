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

/** List-view shape — never includes recipient PII (see module doc, "Recipient PII permission"). */
export interface AlertSummaryDto {
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

export interface AlertDetailDto extends AlertSummaryDto {
  template: TemplateSummaryRef | null;
  templateNameSnapshot: string | null;
  /** DRAFT-editable ad-hoc content, or the frozen source snapshot once READY. Never per-recipient. */
  subject: string | null;
  body: string | null;
  exclusionSummary: Record<string, number> | null;
  sourceContactCount: number;
  sourceGroupCount: number;
  /**
   * DRAFT-time source selections, by name — never phone/email. Distinct from the resolved
   * recipient snapshot (`GET /alerts/:id/recipients`, gated on `alerts.recipients.read`), which
   * carries destination PII. See module doc, "Recipient PII permission".
   */
  sourceContacts: SourceContactRef[];
  sourceGroups: SourceGroupRef[];
  /** Provider-submission outcome counts (Module 10) — safe totals only, never per-recipient. */
  submittedCount: number;
  submissionFailedCount: number;
  pendingDispatchCount: number;
  /** Post-submission delivery-tracking summary (Module 11) — safe aggregate counts only. */
  deliverySummary: DeliverySummaryDto;
}

/**
 * Safe aggregate delivery outcome counts — visible to anyone who can already see the Alert
 * (`alerts.read`); never recipient-level PII. See claude/prompts/11-delivery-tracking.md,
 * "Alert delivery summary".
 */
export interface DeliverySummaryDto {
  total: number;
  submissionFailed: number;
  deliveryPending: number;
  delivered: number;
  undelivered: number;
  bounced: number;
  failed: number;
  /** Derived single-label overview — see module doc, "Alert overall delivery status". */
  overallStatus: "pending" | "in_progress" | "complete" | "partial_failure" | "failed";
  deliveryCompletedAt: string | null;
}

export interface AlertRow {
  id: string;
  alertNumber: string;
  title: string;
  incidentId: string | null;
  incidentNumber: string | null;
  incidentTitle: string | null;
  incidentStatus: string | null;
  templateId: string | null;
  templateName: string | null;
  templateStatus: string | null;
  templateNameSnapshot: string | null;
  channel: string;
  status: string;
  contentSource: string;
  subject: string | null;
  body: string | null;
  eligibleRecipientCount: number | null;
  excludedCount: number | null;
  exclusionSummary: unknown;
  createdByDisplayName: string | null;
  createdAt: Date;
  updatedAt: Date;
  readyAt: Date | null;
  cancelledAt: Date | null;
  sourceContactCount: number;
  sourceGroupCount: number;
  deliveryCompletedAt: Date | null;
}

export function toAlertSummaryDto(row: AlertRow): AlertSummaryDto {
  return {
    id: row.id,
    alertNumber: row.alertNumber,
    title: row.title,
    incident:
      row.incidentId && row.incidentNumber
        ? { id: row.incidentId, incidentNumber: row.incidentNumber, title: row.incidentTitle ?? "", status: row.incidentStatus ?? "" }
        : null,
    channel: row.channel as AlertChannel,
    status: row.status as AlertStatus,
    contentSource: row.contentSource as AlertContentSource,
    eligibleRecipientCount: row.eligibleRecipientCount,
    excludedCount: row.excludedCount,
    createdByDisplayName: row.createdByDisplayName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    readyAt: row.readyAt ? row.readyAt.toISOString() : null,
    cancelledAt: row.cancelledAt ? row.cancelledAt.toISOString() : null,
  };
}

export interface SubmissionCounts {
  submitted: number;
  submissionFailed: number;
  pendingDelivery: number;
}

export interface DeliveryCounts {
  total: number;
  submissionFailed: number;
  deliveryPending: number;
  delivered: number;
  undelivered: number;
  bounced: number;
  failed: number;
}

function deriveOverallDeliveryStatus(counts: DeliveryCounts): DeliverySummaryDto["overallStatus"] {
  const submittedTotal = counts.delivered + counts.undelivered + counts.bounced + counts.failed + counts.deliveryPending;
  if (submittedTotal === 0) {
    return counts.submissionFailed > 0 ? "failed" : "pending";
  }
  if (counts.deliveryPending > 0) return "in_progress";
  if (counts.delivered === 0) return "failed";
  const anyFailureLike = counts.undelivered + counts.bounced + counts.failed > 0;
  return anyFailureLike ? "partial_failure" : "complete";
}

export function toAlertDetailDto(
  row: AlertRow,
  sourceContacts: SourceContactRef[] = [],
  sourceGroups: SourceGroupRef[] = [],
  submission: SubmissionCounts = { submitted: 0, submissionFailed: 0, pendingDelivery: 0 },
  delivery: DeliveryCounts = { total: 0, submissionFailed: 0, deliveryPending: 0, delivered: 0, undelivered: 0, bounced: 0, failed: 0 },
): AlertDetailDto {
  return {
    ...toAlertSummaryDto(row),
    template: row.templateId && row.templateName ? { id: row.templateId, name: row.templateName, status: row.templateStatus ?? "" } : null,
    templateNameSnapshot: row.templateNameSnapshot,
    subject: row.subject,
    body: row.body,
    exclusionSummary: (row.exclusionSummary as Record<string, number> | null) ?? null,
    sourceContactCount: row.sourceContactCount,
    sourceGroupCount: row.sourceGroupCount,
    sourceContacts,
    sourceGroups,
    submittedCount: submission.submitted,
    submissionFailedCount: submission.submissionFailed,
    pendingDispatchCount: submission.pendingDelivery,
    deliverySummary: {
      total: delivery.total,
      submissionFailed: delivery.submissionFailed,
      deliveryPending: delivery.deliveryPending,
      delivered: delivery.delivered,
      undelivered: delivery.undelivered,
      bounced: delivery.bounced,
      failed: delivery.failed,
      overallStatus: deriveOverallDeliveryStatus(delivery),
      deliveryCompletedAt: row.deliveryCompletedAt ? row.deliveryCompletedAt.toISOString() : null,
    },
  };
}

/** Only ever returned from a `alerts.recipients.read`-gated endpoint — carries destination PII. */
export interface AlertRecipientDto {
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

export interface AlertRecipientRow {
  id: string;
  contactId: string | null;
  recipientName: string | null;
  recipientAddress: string | null;
  channel: string;
  renderedSubject: string | null;
  renderedBody: string | null;
  status: string;
  provider: string | null;
  providerMessageId: string | null;
  attemptCount: number;
  lastFailureClass: string | null;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  submittedAt: Date | null;
  failedAt: Date | null;
  deliveryStatus: string | null;
  deliveryUpdatedAt: Date | null;
  deliveredAt: Date | null;
  providerDeliveryCode: string | null;
  deliveryErrorSummary: string | null;
  createdAt: Date;
}

export function toAlertRecipientDto(row: AlertRecipientRow): AlertRecipientDto {
  return {
    id: row.id,
    contactId: row.contactId,
    displayName: row.recipientName,
    destination: row.recipientAddress,
    channel: row.channel as AlertChannel,
    renderedSubject: row.renderedSubject,
    renderedBody: row.renderedBody,
    status: row.status,
    deliveryStatus: row.deliveryStatus,
    deliveryUpdatedAt: row.deliveryUpdatedAt ? row.deliveryUpdatedAt.toISOString() : null,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    providerDeliveryCode: row.providerDeliveryCode,
    deliveryErrorSummary: row.deliveryErrorSummary,
    provider: row.provider,
    providerMessageId: row.providerMessageId,
    attemptCount: row.attemptCount,
    lastFailureClass: row.lastFailureClass,
    lastErrorCode: row.lastErrorCode,
    lastErrorSummary: row.lastErrorSummary,
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    failedAt: row.failedAt ? row.failedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Safe operational summary — never provider credentials, never the full destination list. */
export interface DispatchSummaryDto {
  alertId: string;
  status: AlertStatus;
  totalRecipients: number;
  submitted: number;
  submissionFailed: number;
  pending: number;
}
