import { and, eq, inArray } from "drizzle-orm";
import { alerts, alertRecipients, type Database, type DbOrTx } from "@beacon/database";
import { AuthError } from "../auth/errors.js";
import { recordAuthEvent } from "../auth/audit.js";
import { appendTimelineEvent } from "../incidents/timelineQueries.js";
import { findIncidentById, findIncidentForUpdate } from "../incidents/incidentQueries.js";
import { findTemplateById } from "../templates/templateQueries.js";
import { renderTemplate, validateTemplateContent } from "../templates/rendering.js";
import { samplePlaceholderValues } from "../templates/placeholders.js";
import { estimateSmsSegments, type SmsSegmentEstimate } from "../templates/smsSegments.js";
import type { AlertConfig } from "./config.js";
import {
  generateAlertNumber,
  findAlertById,
  findAlertForUpdate,
  listAlerts as queryAlerts,
  getContactSelectionIds,
  getGroupSelectionIds,
  getContactSelectionSummaries,
  getGroupSelectionSummaries,
  replaceContactSelections,
  replaceGroupSelections,
  normalizePagination,
  type ListAlertsFilter,
} from "./alertQueries.js";
import { resolveRecipients } from "./recipientResolution.js";
import { listAlertRecipients as queryAlertRecipients } from "./alertRecipientQueries.js";
import {
  toAlertDetailDto,
  toAlertRecipientDto,
  toAlertSummaryDto,
  type AlertChannel,
  type AlertContentSource,
  type AlertDetailDto,
  type AlertRecipientDto,
  type AlertSummaryDto,
  type DispatchSummaryDto,
} from "./dto.js";
import type { NotificationConfig } from "../notifications/config.js";
import { getSmsProvider, getEmailProvider } from "../notifications/providers/registry.js";
import { dispatchRecipients } from "../notifications/dispatchEngine.js";
import { getPendingRecipients, getRecipientStatusCounts } from "../notifications/dispatchQueries.js";

const TITLE_MAX_LENGTH = 255;
const SUBJECT_MAX_LENGTH = 255;
const BODY_MAX_LENGTH = 5000;
const CHANNELS: readonly AlertChannel[] = ["sms", "email"];
const CONTENT_SOURCES: readonly AlertContentSource[] = ["template", "adhoc"];

function validateTitle(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AuthError(400, "invalid_request", "Alert title is required.");
  }
  if (trimmed.length > TITLE_MAX_LENGTH) {
    throw new AuthError(400, "invalid_request", `Alert title must be ${TITLE_MAX_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function validateChannel(value: string): AlertChannel {
  if (!CHANNELS.includes(value as AlertChannel)) {
    throw new AuthError(400, "invalid_request", `Channel must be one of: ${CHANNELS.join(", ")}.`);
  }
  return value as AlertChannel;
}

function validateContentSource(value: string): AlertContentSource {
  if (!CONTENT_SOURCES.includes(value as AlertContentSource)) {
    throw new AuthError(400, "invalid_request", `Content source must be one of: ${CONTENT_SOURCES.join(", ")}.`);
  }
  return value as AlertContentSource;
}

function assertContentIsInert(text: string, label: string): void {
  const result = validateTemplateContent(text);
  if (!result.valid) {
    throw new AuthError(400, "invalid_request", `${label}: ${result.errors.join(" ")}`);
  }
}

/** Same subject rule as Templates (Module 07): SMS never has one, Email always requires one. */
function validateAdhocSubjectForChannel(channel: AlertChannel, subject: string | undefined): string | null {
  if (channel === "sms") {
    if (subject !== undefined && subject.trim().length > 0) {
      throw new AuthError(400, "invalid_request", "SMS alerts do not use a subject.");
    }
    return null;
  }
  const trimmed = (subject ?? "").trim();
  if (!trimmed) return null; // Not required until READY for ad-hoc DRAFT content — see module doc.
  if (trimmed.length > SUBJECT_MAX_LENGTH) {
    throw new AuthError(400, "invalid_request", `Subject must be ${SUBJECT_MAX_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function validateAdhocBody(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value.length > BODY_MAX_LENGTH) {
    throw new AuthError(400, "invalid_request", `Message body must be ${BODY_MAX_LENGTH} characters or fewer.`);
  }
  return value || null;
}

async function assertIncidentEligible(db: DbOrTx, incidentId: string): Promise<void> {
  const incident = await findIncidentById(db, incidentId);
  if (!incident) {
    throw new AuthError(400, "invalid_request", "Incident not found.");
  }
  if (incident.status === "closed") {
    throw new AuthError(409, "incident_not_eligible", "This Incident is closed; it cannot be linked to a new Alert.");
  }
}

async function assertTemplateReferenceValid(db: DbOrTx, templateId: string, channel: AlertChannel): Promise<void> {
  const template = await findTemplateById(db, templateId);
  if (!template) {
    throw new AuthError(400, "invalid_request", "Template not found.");
  }
  if (template.channel !== channel) {
    throw new AuthError(400, "invalid_request", "Template channel does not match the Alert's channel.");
  }
}

async function loadDto(db: DbOrTx, id: string): Promise<AlertDetailDto> {
  const row = await findAlertById(db, id);
  if (!row) {
    throw new AuthError(404, "not_found", "Alert not found.");
  }
  const [sourceContacts, sourceGroups, counts] = await Promise.all([
    getContactSelectionSummaries(db, id),
    getGroupSelectionSummaries(db, id),
    getRecipientStatusCounts(db, id),
  ]);
  return toAlertDetailDto(row, sourceContacts, sourceGroups, {
    submitted: counts.submitted,
    submissionFailed: counts.submissionFailed,
    pendingDelivery: counts.pendingDelivery,
  });
}

export interface ListAlertsOptions {
  search?: string;
  status?: string;
  channel?: string;
  incidentId?: string;
  page?: number;
  pageSize?: number;
}

export interface ListAlertsResponse {
  items: AlertSummaryDto[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listAlerts(db: Database, options: ListAlertsOptions): Promise<ListAlertsResponse> {
  const { page, pageSize } = normalizePagination(options.page, options.pageSize);
  const filter: ListAlertsFilter = { ...options, page, pageSize };
  const result = await queryAlerts(db, filter);
  return { items: result.items.map(toAlertSummaryDto), total: result.total, page, pageSize };
}

export async function getAlert(db: Database, id: string): Promise<AlertDetailDto> {
  return loadDto(db, id);
}

export interface CreateAlertInput {
  title: string;
  incidentId?: string;
  channel: string;
  contentSource: string;
  templateId?: string;
  subject?: string;
  body?: string;
  contactIds?: string[];
  groupIds?: string[];
}

export async function createAlert(db: Database, input: CreateAlertInput, actorId: string): Promise<AlertDetailDto> {
  const title = validateTitle(input.title);
  const channel = validateChannel(input.channel);
  const contentSource = validateContentSource(input.contentSource);

  if (input.incidentId) {
    await assertIncidentEligible(db, input.incidentId);
  }

  let subject: string | null = null;
  let body: string | null = null;
  if (contentSource === "template") {
    if (!input.templateId) {
      throw new AuthError(400, "invalid_request", "A Template-based Alert requires a templateId.");
    }
    await assertTemplateReferenceValid(db, input.templateId, channel);
  } else {
    subject = validateAdhocSubjectForChannel(channel, input.subject);
    body = validateAdhocBody(input.body);
    if (body) assertContentIsInert(body, "Message body");
    if (subject) assertContentIsInert(subject, "Subject");
  }

  const contactIds = [...new Set(input.contactIds ?? [])];
  const groupIds = [...new Set(input.groupIds ?? [])];

  const alertId = await db.transaction(async (tx) => {
    const alertNumber = await generateAlertNumber(tx);

    const [created] = await tx
      .insert(alerts)
      .values({
        alertNumber,
        title,
        incidentId: input.incidentId ?? null,
        templateId: contentSource === "template" ? input.templateId : null,
        contentSource,
        channel,
        subject,
        body,
        status: "draft",
        createdBy: actorId,
      })
      .returning({ id: alerts.id });
    if (!created) {
      throw new AuthError(500, "not_found", "Alert creation failed unexpectedly.");
    }

    await replaceContactSelections(tx, created.id, contactIds);
    await replaceGroupSelections(tx, created.id, groupIds);

    if (input.incidentId) {
      await appendTimelineEvent(tx, {
        incidentId: input.incidentId,
        eventType: "ALERT_CREATED",
        actorUserId: actorId,
        metadata: { alertId: created.id, channel },
      });
    }
    await recordAuthEvent(tx, {
      eventType: "ALERT_CREATED",
      actorId,
      resourceType: "alert",
      resourceId: created.id,
      ...(input.incidentId ? { incidentId: input.incidentId } : {}),
      metadata: { alertNumber, channel, contentSource },
    });

    return created.id;
  });

  return loadDto(db, alertId);
}

export interface UpdateAlertInput {
  title?: string;
  incidentId?: string | null;
  channel?: string;
  templateId?: string | null;
  contentSource?: string;
  subject?: string;
  body?: string;
  contactIds?: string[];
  groupIds?: string[];
}

export async function updateAlert(
  db: Database,
  id: string,
  input: UpdateAlertInput,
  actorId: string,
): Promise<AlertDetailDto> {
  await db.transaction(async (tx) => {
    const current = await findAlertForUpdate(tx, id);
    if (!current) {
      throw new AuthError(404, "not_found", "Alert not found.");
    }
    if (current.status !== "draft") {
      throw new AuthError(409, "alert_not_draft", "Only a DRAFT Alert can be edited.");
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    const changedFields: string[] = [];

    const nextChannel = input.channel !== undefined ? validateChannel(input.channel) : (current.channel as AlertChannel);
    if (input.channel !== undefined) {
      patch.channel = nextChannel;
      changedFields.push("channel");
    }

    if (input.incidentId !== undefined) {
      if (input.incidentId) await assertIncidentEligible(tx, input.incidentId);
      patch.incidentId = input.incidentId;
      changedFields.push("incidentId");
    }

    if (input.title !== undefined) {
      patch.title = validateTitle(input.title);
      changedFields.push("title");
    }

    if (input.contentSource !== undefined) {
      const contentSource = validateContentSource(input.contentSource);
      patch.contentSource = contentSource;
      changedFields.push("contentSource");
    }
    if (input.templateId !== undefined) {
      if (input.templateId) await assertTemplateReferenceValid(tx, input.templateId, nextChannel);
      patch.templateId = input.templateId;
      changedFields.push("templateId");
    }
    if (input.subject !== undefined) {
      const subject = validateAdhocSubjectForChannel(nextChannel, input.subject);
      if (subject) assertContentIsInert(subject, "Subject");
      patch.subject = subject;
      changedFields.push("subject");
    }
    if (input.body !== undefined) {
      const body = validateAdhocBody(input.body);
      if (body) assertContentIsInert(body, "Message body");
      patch.body = body;
      changedFields.push("body");
    }

    if (input.contactIds !== undefined) {
      await replaceContactSelections(tx, id, [...new Set(input.contactIds)]);
      changedFields.push("contactIds");
    }
    if (input.groupIds !== undefined) {
      await replaceGroupSelections(tx, id, [...new Set(input.groupIds)]);
      changedFields.push("groupIds");
    }

    if (changedFields.length === 0) return;

    await tx.update(alerts).set(patch).where(eq(alerts.id, id));

    if (current.incidentId) {
      await appendTimelineEvent(tx, {
        incidentId: current.incidentId,
        eventType: "ALERT_UPDATED",
        actorUserId: actorId,
        metadata: { alertId: id, fields: changedFields },
      });
    }
    await recordAuthEvent(tx, {
      eventType: "ALERT_UPDATED",
      actorId,
      resourceType: "alert",
      resourceId: id,
      ...(current.incidentId ? { incidentId: current.incidentId } : {}),
      metadata: { fields: changedFields },
    });
  });

  return loadDto(db, id);
}

export interface PreviewResponse {
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
  sms?: SmsSegmentEstimate;
}

/**
 * Server-authoritative audience + content preview — never persists anything, never transitions
 * status. Sample content uses Module 07's synthetic placeholder values (never a real Contact's
 * name), so this endpoint never needs `alerts.recipients.read`. See module doc, "Preview model".
 */
export async function previewAlert(db: Database, id: string): Promise<PreviewResponse> {
  const alert = await findAlertById(db, id);
  if (!alert) {
    throw new AuthError(404, "not_found", "Alert not found.");
  }
  if (alert.status !== "draft") {
    throw new AuthError(409, "alert_not_draft", "Only a DRAFT Alert can be previewed.");
  }

  const channel = alert.channel as AlertChannel;
  const contactIds = await getContactSelectionIds(db, id);
  const groupIds = await getGroupSelectionIds(db, id);
  const resolved = await resolveRecipients(db, { contactIds, groupIds, channel });

  let subject: string | undefined;
  let body: string;
  let templateActive: boolean | null = null;

  if (alert.contentSource === "template" && alert.templateId) {
    const template = await findTemplateById(db, alert.templateId);
    if (!template) {
      throw new AuthError(400, "invalid_request", "Template not found.");
    }
    templateActive = template.status === "active";
    subject = template.subject ?? undefined;
    body = template.body;
  } else {
    subject = alert.subject ?? undefined;
    body = alert.body ?? "";
  }

  const rendered = renderTemplate({ subject, body, values: samplePlaceholderValues() });

  const response: PreviewResponse = {
    channel,
    uniqueRecipientCount: resolved.eligible.length + resolved.excluded.length,
    eligibleCount: resolved.eligible.length,
    excludedCount: resolved.excluded.length,
    exclusionSummary: resolved.exclusionSummary,
    duplicatesCollapsedCount: resolved.duplicatesCollapsedCount,
    invalidGroupIds: resolved.invalidGroupIds,
    zeroRecipientWarning: resolved.eligible.length === 0,
    templateActive,
    sampleRenderedBody: rendered.renderedBody,
  };
  if (rendered.renderedSubject !== undefined) response.sampleRenderedSubject = rendered.renderedSubject;
  if (channel === "sms") response.sms = estimateSmsSegments(rendered.renderedBody);
  return response;
}

export async function readyAlert(db: Database, id: string, actorId: string, config: AlertConfig): Promise<AlertDetailDto> {
  await db.transaction(async (tx) => {
    const current = await findAlertForUpdate(tx, id);
    if (!current) {
      throw new AuthError(404, "not_found", "Alert not found.");
    }
    if (current.status !== "draft") {
      throw new AuthError(409, "alert_not_draft", "Only a DRAFT Alert can become READY.");
    }

    const channel = current.channel as AlertChannel;

    if (current.incidentId) {
      const incident = await findIncidentForUpdate(tx, current.incidentId);
      if (!incident) {
        throw new AuthError(400, "invalid_request", "Linked Incident not found.");
      }
      if (incident.status === "closed") {
        throw new AuthError(409, "incident_not_eligible", "This Incident is closed; the Alert cannot become READY.");
      }
    }

    const [alertRow] = await tx.select().from(alerts).where(eq(alerts.id, id)).limit(1);
    if (!alertRow) {
      throw new AuthError(404, "not_found", "Alert not found.");
    }

    let sourceSubject: string | undefined;
    let sourceBody: string;
    let templateNameSnapshot: string | null = null;

    if (alertRow.contentSource === "template") {
      if (!alertRow.templateId) {
        throw new AuthError(400, "invalid_request", "This Alert has no Template selected.");
      }
      const template = await findTemplateById(tx, alertRow.templateId);
      if (!template || template.status !== "active") {
        throw new AuthError(409, "template_not_usable", "The selected Template is no longer active.");
      }
      sourceSubject = template.subject ?? undefined;
      sourceBody = template.body;
      templateNameSnapshot = template.name;
    } else {
      sourceSubject = alertRow.subject ?? undefined;
      sourceBody = alertRow.body ?? "";
      if (!sourceBody.trim()) {
        throw new AuthError(400, "invalid_request", "Ad-hoc Alert content requires a message body.");
      }
      if (channel === "email" && !(sourceSubject && sourceSubject.trim())) {
        throw new AuthError(400, "invalid_request", "Ad-hoc Email Alert content requires a subject.");
      }
    }

    const contactIds = await getContactSelectionIds(tx, id);
    const groupIds = await getGroupSelectionIds(tx, id);
    const resolved = await resolveRecipients(tx, { contactIds, groupIds, channel });

    if (resolved.invalidGroupIds.length > 0) {
      throw new AuthError(
        409,
        "invalid_group_selection",
        "One or more selected Groups is no longer active. Remove it from the audience before continuing.",
      );
    }
    if (resolved.eligible.length === 0) {
      throw new AuthError(409, "zero_eligible_recipients", "This Alert has zero eligible recipients and cannot become READY.");
    }
    if (resolved.eligible.length > config.maxRecipients) {
      throw new AuthError(
        409,
        "recipient_limit_exceeded",
        `This Alert has ${resolved.eligible.length} eligible recipients, exceeding the configured limit of ${config.maxRecipients}.`,
      );
    }

    const recipientRows = resolved.eligible.map((contact) => {
      const destination = channel === "sms" ? contact.mobilePhone! : contact.email!;
      const rendered = renderTemplate({
        subject: sourceSubject,
        body: sourceBody,
        values: {
          firstName: contact.firstName,
          lastName: contact.lastName,
          displayName: `${contact.firstName} ${contact.lastName}`.trim(),
        },
      });
      return {
        alertId: id,
        contactId: contact.id,
        recipientName: `${contact.firstName} ${contact.lastName}`.trim(),
        recipientAddress: destination,
        renderedSubject: rendered.renderedSubject ?? null,
        renderedBody: rendered.renderedBody,
        channel,
        status: "pending_delivery" as const,
      };
    });

    await tx.insert(alertRecipients).values(recipientRows);

    await tx
      .update(alerts)
      .set({
        status: "ready",
        subject: sourceSubject ?? null,
        body: sourceBody,
        templateNameSnapshot,
        eligibleRecipientCount: resolved.eligible.length,
        excludedCount: resolved.excluded.length,
        exclusionSummary: resolved.exclusionSummary,
        readyAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(alerts.id, id));

    if (current.incidentId) {
      await appendTimelineEvent(tx, {
        incidentId: current.incidentId,
        eventType: "ALERT_READY",
        actorUserId: actorId,
        metadata: {
          alertId: id,
          channel,
          eligibleRecipientCount: resolved.eligible.length,
          excludedCount: resolved.excluded.length,
        },
      });
    }
    await recordAuthEvent(tx, {
      eventType: "ALERT_READY",
      actorId,
      resourceType: "alert",
      resourceId: id,
      ...(current.incidentId ? { incidentId: current.incidentId } : {}),
      metadata: {
        alertNumber: alertRow.alertNumber,
        channel,
        eligibleRecipientCount: resolved.eligible.length,
        excludedCount: resolved.excluded.length,
      },
    });
  });

  return loadDto(db, id);
}

/**
 * Cancellation rule, revised for Module 10 (see claude/prompts/10-notification-providers.md,
 * "Cancellation semantics"): a READY Alert may still be cancelled only while every one of its
 * recipient snapshots is still `pending_delivery` — i.e. dispatch has never actually claimed any
 * of them. Once any recipient has moved past `pending_delivery` (claimed/dispatching/submitted/
 * submission_failed), cancellation is rejected — BEACON never claims to "recall" a message that
 * may already be in flight to (or accepted by) the provider.
 */
export async function cancelAlert(db: Database, id: string, actorId: string): Promise<AlertDetailDto> {
  await db.transaction(async (tx) => {
    const current = await findAlertForUpdate(tx, id);
    if (!current) {
      throw new AuthError(404, "not_found", "Alert not found.");
    }
    const DISPATCH_STARTED_STATUSES = ["dispatching", "submitted", "partially_submitted", "submission_failed"];
    if (DISPATCH_STARTED_STATUSES.includes(current.status)) {
      throw new AuthError(
        409,
        "dispatch_already_started",
        "This Alert's dispatch has already begun; it can no longer be cancelled.",
      );
    }
    if (current.status !== "draft" && current.status !== "ready") {
      throw new AuthError(409, "invalid_transition", "Only a DRAFT or READY Alert can be cancelled.");
    }
    if (current.status === "ready") {
      const counts = await getRecipientStatusCounts(tx, id);
      if (counts.total - counts.pendingDelivery > 0) {
        throw new AuthError(
          409,
          "dispatch_already_started",
          "This Alert's dispatch has already begun; it can no longer be cancelled.",
        );
      }
    }

    const now = new Date();
    await tx.update(alerts).set({ status: "cancelled", cancelledAt: now, updatedAt: now }).where(eq(alerts.id, id));

    const [row] = await tx
      .select({ alertNumber: alerts.alertNumber, channel: alerts.channel })
      .from(alerts)
      .where(eq(alerts.id, id))
      .limit(1);

    if (current.incidentId) {
      await appendTimelineEvent(tx, {
        incidentId: current.incidentId,
        eventType: "ALERT_CANCELLED",
        actorUserId: actorId,
        metadata: { alertId: id, channel: row!.channel },
      });
    }
    await recordAuthEvent(tx, {
      eventType: "ALERT_CANCELLED",
      actorId,
      resourceType: "alert",
      resourceId: id,
      ...(current.incidentId ? { incidentId: current.incidentId } : {}),
      metadata: { alertNumber: row!.alertNumber },
    });
  });

  return loadDto(db, id);
}

export interface ListAlertRecipientsResponse {
  items: AlertRecipientDto[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listAlertRecipients(
  db: Database,
  alertId: string,
  options: { page?: number; pageSize?: number },
): Promise<ListAlertRecipientsResponse> {
  const alert = await findAlertById(db, alertId);
  if (!alert) {
    throw new AuthError(404, "not_found", "Alert not found.");
  }
  const { page, pageSize } = normalizePagination(options.page, options.pageSize);
  const result = await queryAlertRecipients(db, alertId, { page, pageSize });
  return { items: result.items.map(toAlertRecipientDto), total: result.total, page, pageSize };
}

const DISPATCHABLE_FROM: readonly string[] = ["ready", "partially_submitted", "submission_failed"];

function deriveAlertStatus(counts: Awaited<ReturnType<typeof getRecipientStatusCounts>>): AlertDetailDto["status"] {
  if (counts.pendingDelivery > 0 || counts.dispatching > 0) return "dispatching";
  if (counts.submissionFailed > 0 && counts.submitted > 0) return "partially_submitted";
  if (counts.submissionFailed > 0) return "submission_failed";
  return "submitted";
}

/**
 * Explicit dispatch operation — READY only *approves* a communication plan; this is the
 * deliberate, separate action that actually begins provider submission. See module doc,
 * "READY vs Dispatch". Idempotent and safely re-invokable: recipients already claimed by an
 * earlier call (submitted or submission_failed) are never resubmitted — see
 * claude/prompts/10-notification-providers.md, "Idempotency model".
 */
export async function dispatchAlert(
  db: Database,
  id: string,
  actorId: string,
  notificationConfig: NotificationConfig,
): Promise<DispatchSummaryDto> {
  const current = await findAlertById(db, id);
  if (!current) {
    throw new AuthError(404, "not_found", "Alert not found.");
  }

  if (current.status === "submitted") {
    // Idempotent no-op: fully submitted already — report the current state, not an error.
    const counts = await getRecipientStatusCounts(db, id);
    return {
      alertId: id,
      status: "submitted",
      totalRecipients: counts.total,
      submitted: counts.submitted,
      submissionFailed: counts.submissionFailed,
      pending: counts.pendingDelivery,
    };
  }
  if (current.status === "draft") {
    throw new AuthError(409, "alert_not_ready", "Only a READY Alert can be dispatched.");
  }
  if (current.status === "cancelled") {
    throw new AuthError(409, "alert_cancelled", "A cancelled Alert cannot be dispatched.");
  }
  if (current.status === "dispatching") {
    throw new AuthError(409, "dispatch_in_progress", "This Alert's dispatch is already in progress.");
  }
  if (!DISPATCHABLE_FROM.includes(current.status)) {
    throw new AuthError(409, "alert_not_ready", "Only a READY Alert can be dispatched.");
  }

  if (current.incidentId) {
    const incident = await findIncidentById(db, current.incidentId);
    if (!incident) {
      throw new AuthError(400, "invalid_request", "Linked Incident not found.");
    }
    // Once dispatch validly begins below, a later Incident closure does not interrupt in-flight
    // recipient processing for this same call — see module doc, "Incident CLOSED behavior".
    if (incident.status === "closed") {
      throw new AuthError(409, "incident_not_eligible", "This Incident is closed; the Alert cannot be dispatched.");
    }
  }

  const preCounts = await getRecipientStatusCounts(db, id);
  if (preCounts.total === 0) {
    throw new AuthError(409, "no_recipients", "This Alert has no recipient snapshot to dispatch.");
  }

  // Resolve providers before mutating anything — an unsupported/misconfigured provider fails
  // safely without ever marking the Alert as dispatching. See module doc, "Provider registry".
  const providers = { sms: getSmsProvider(notificationConfig), email: getEmailProvider(notificationConfig) };

  const [claimed] = await db
    .update(alerts)
    .set({ status: "dispatching", updatedAt: new Date() })
    .where(and(eq(alerts.id, id), inArray(alerts.status, [...DISPATCHABLE_FROM])))
    .returning({ id: alerts.id, incidentId: alerts.incidentId, channel: alerts.channel, alertNumber: alerts.alertNumber });

  if (!claimed) {
    // Lost a race against a concurrent dispatch call for the same Alert — the other request owns
    // this dispatch; report a clean conflict rather than silently proceeding.
    throw new AuthError(409, "dispatch_in_progress", "This Alert's dispatch is already in progress.");
  }

  try {
    if (claimed.incidentId) {
      await appendTimelineEvent(db, {
        incidentId: claimed.incidentId,
        eventType: "ALERT_DISPATCH_STARTED",
        actorUserId: actorId,
        metadata: { alertId: id, channel: claimed.channel },
      });
    }
    await recordAuthEvent(db, {
      eventType: "ALERT_DISPATCH_STARTED",
      actorId,
      resourceType: "alert",
      resourceId: id,
      ...(claimed.incidentId ? { incidentId: claimed.incidentId } : {}),
      metadata: { alertNumber: claimed.alertNumber, channel: claimed.channel, provider: providerNameFor(claimed.channel, providers) },
    });

    const pending = await getPendingRecipients(db, id);
    await dispatchRecipients(db, id, pending, providers, {
      maxAttempts: notificationConfig.maxAttempts,
      retryBaseMs: notificationConfig.retryBaseMs,
      concurrency: notificationConfig.dispatchConcurrency,
      providerTimeoutMs: notificationConfig.providerTimeoutMs,
    });

    const counts = await getRecipientStatusCounts(db, id);
    const finalStatus = deriveAlertStatus(counts);
    await db.update(alerts).set({ status: finalStatus, updatedAt: new Date() }).where(eq(alerts.id, id));

    if (claimed.incidentId) {
      await appendTimelineEvent(db, {
        incidentId: claimed.incidentId,
        eventType: "ALERT_DISPATCH_COMPLETED",
        actorUserId: actorId,
        metadata: { alertId: id, channel: claimed.channel, submittedCount: counts.submitted, failedCount: counts.submissionFailed },
      });
    }
    await recordAuthEvent(db, {
      eventType: "ALERT_DISPATCH_COMPLETED",
      actorId,
      resourceType: "alert",
      resourceId: id,
      ...(claimed.incidentId ? { incidentId: claimed.incidentId } : {}),
      metadata: {
        alertNumber: claimed.alertNumber,
        channel: claimed.channel,
        totalCount: counts.total,
        submittedCount: counts.submitted,
        failedCount: counts.submissionFailed,
      },
    });

    return {
      alertId: id,
      status: finalStatus,
      totalRecipients: counts.total,
      submitted: counts.submitted,
      submissionFailed: counts.submissionFailed,
      pending: counts.pendingDelivery,
    };
  } catch (error) {
    // Never leave the Alert stuck in "dispatching" on an unexpected error — recompute from
    // whatever recipient state actually exists so the Alert reflects reality.
    const counts = await getRecipientStatusCounts(db, id);
    const fallbackStatus = counts.total > 0 ? deriveAlertStatus(counts) : "submission_failed";
    await db.update(alerts).set({ status: fallbackStatus, updatedAt: new Date() }).where(eq(alerts.id, id));
    throw error;
  }
}

function providerNameFor(channel: string, providers: { sms: { name: string }; email: { name: string } }): string {
  return channel === "sms" ? providers.sms.name : providers.email.name;
}
