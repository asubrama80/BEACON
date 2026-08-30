import { and, eq, sql } from "drizzle-orm";
import { alertRecipients, notificationDispatchAttempts, type Database, type DbOrTx } from "@beacon/database";
import type { FailureClass, ProviderSubmissionResult } from "./providers/types.js";

export interface RecipientToDispatch {
  id: string;
  channel: "sms" | "email";
  destination: string;
  renderedSubject: string | null;
  renderedBody: string;
}

/** Only rows still awaiting submission — never touches Contact/Template data. */
export async function getPendingRecipients(db: DbOrTx, alertId: string): Promise<RecipientToDispatch[]> {
  const rows = await db
    .select({
      id: alertRecipients.id,
      channel: alertRecipients.channel,
      destination: alertRecipients.recipientAddress,
      renderedSubject: alertRecipients.renderedSubject,
      renderedBody: alertRecipients.renderedBody,
    })
    .from(alertRecipients)
    .where(and(eq(alertRecipients.alertId, alertId), eq(alertRecipients.status, "pending_delivery")));

  return rows.map((r) => ({
    id: r.id,
    channel: r.channel as "sms" | "email",
    destination: r.destination!,
    renderedSubject: r.renderedSubject,
    renderedBody: r.renderedBody!,
  }));
}

/**
 * The idempotency guarantee: only one caller can ever win this conditional UPDATE for a given
 * recipient. A second concurrent/duplicate dispatch attempt (double-click, retried request, a
 * second backend instance) sees 0 affected rows and skips the recipient entirely — it never
 * submits a second time. See claude/prompts/10-notification-providers.md, "Idempotency model".
 */
export async function claimRecipientForDispatch(db: DbOrTx, recipientId: string): Promise<{ attemptCount: number } | undefined> {
  const [row] = await db
    .update(alertRecipients)
    .set({ status: "dispatching", attemptCount: sql`${alertRecipients.attemptCount} + 1`, updatedAt: new Date() })
    .where(and(eq(alertRecipients.id, recipientId), eq(alertRecipients.status, "pending_delivery")))
    .returning({ attemptCount: alertRecipients.attemptCount });
  return row;
}

export async function incrementRecipientAttempt(db: DbOrTx, recipientId: string): Promise<number> {
  const [row] = await db
    .update(alertRecipients)
    .set({ attemptCount: sql`${alertRecipients.attemptCount} + 1`, updatedAt: new Date() })
    .where(eq(alertRecipients.id, recipientId))
    .returning({ attemptCount: alertRecipients.attemptCount });
  return row!.attemptCount;
}

export async function markRecipientSubmitted(db: DbOrTx, recipientId: string, result: ProviderSubmissionResult): Promise<void> {
  await db
    .update(alertRecipients)
    .set({
      status: "submitted",
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      submittedAt: new Date(),
      lastFailureClass: null,
      lastErrorCode: null,
      lastErrorSummary: null,
      updatedAt: new Date(),
    })
    .where(eq(alertRecipients.id, recipientId));
}

export async function markRecipientFailed(db: DbOrTx, recipientId: string, result: ProviderSubmissionResult): Promise<void> {
  await db
    .update(alertRecipients)
    .set({
      status: "submission_failed",
      provider: result.provider,
      failedAt: new Date(),
      lastFailureClass: result.failureClass ?? null,
      lastErrorCode: result.errorCode ?? null,
      lastErrorSummary: result.safeErrorMessage ?? null,
      updatedAt: new Date(),
    })
    .where(eq(alertRecipients.id, recipientId));
}

export interface InsertAttemptInput {
  alertId: string;
  alertRecipientId: string;
  channel: "sms" | "email";
  provider: string;
  attemptNumber: number;
}

/** Persisted before the provider call — reduces (never eliminates) the crash-window ambiguity. */
export async function insertDispatchAttempt(db: DbOrTx, input: InsertAttemptInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(notificationDispatchAttempts)
    .values({
      alertId: input.alertId,
      alertRecipientId: input.alertRecipientId,
      channel: input.channel,
      provider: input.provider,
      attemptNumber: input.attemptNumber,
      status: "dispatching",
    })
    .returning({ id: notificationDispatchAttempts.id });
  return row!;
}

export async function completeDispatchAttempt(db: DbOrTx, attemptId: string, result: ProviderSubmissionResult): Promise<void> {
  await db
    .update(notificationDispatchAttempts)
    .set({
      status: result.accepted ? "submitted" : "submission_failed",
      providerMessageId: result.providerMessageId,
      failureClass: (result.failureClass ?? null) as FailureClass | null,
      providerErrorCode: result.errorCode ?? null,
      safeErrorSummary: result.safeErrorMessage ?? null,
      completedAt: new Date(),
    })
    .where(eq(notificationDispatchAttempts.id, attemptId));
}

export interface RecipientStatusCounts {
  total: number;
  pendingDelivery: number;
  dispatching: number;
  submitted: number;
  submissionFailed: number;
}

export async function getRecipientStatusCounts(db: DbOrTx, alertId: string): Promise<RecipientStatusCounts> {
  const rows = await db
    .select({ status: alertRecipients.status, count: sql<number>`count(*)::int` })
    .from(alertRecipients)
    .where(eq(alertRecipients.alertId, alertId))
    .groupBy(alertRecipients.status);

  const counts: RecipientStatusCounts = { total: 0, pendingDelivery: 0, dispatching: 0, submitted: 0, submissionFailed: 0 };
  for (const row of rows) {
    counts.total += row.count;
    if (row.status === "pending_delivery") counts.pendingDelivery = row.count;
    else if (row.status === "dispatching") counts.dispatching = row.count;
    else if (row.status === "submitted") counts.submitted = row.count;
    else if (row.status === "submission_failed") counts.submissionFailed = row.count;
  }
  return counts;
}

export interface DispatchAttemptRow {
  id: string;
  alertRecipientId: string;
  channel: string;
  provider: string;
  attemptNumber: number;
  status: string;
  providerMessageId: string | null;
  failureClass: string | null;
  providerErrorCode: string | null;
  safeErrorSummary: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

export async function listAttemptsForRecipient(db: Database, alertRecipientId: string): Promise<DispatchAttemptRow[]> {
  return db
    .select({
      id: notificationDispatchAttempts.id,
      alertRecipientId: notificationDispatchAttempts.alertRecipientId,
      channel: notificationDispatchAttempts.channel,
      provider: notificationDispatchAttempts.provider,
      attemptNumber: notificationDispatchAttempts.attemptNumber,
      status: notificationDispatchAttempts.status,
      providerMessageId: notificationDispatchAttempts.providerMessageId,
      failureClass: notificationDispatchAttempts.failureClass,
      providerErrorCode: notificationDispatchAttempts.providerErrorCode,
      safeErrorSummary: notificationDispatchAttempts.safeErrorSummary,
      startedAt: notificationDispatchAttempts.startedAt,
      completedAt: notificationDispatchAttempts.completedAt,
    })
    .from(notificationDispatchAttempts)
    .where(eq(notificationDispatchAttempts.alertRecipientId, alertRecipientId))
    .orderBy(notificationDispatchAttempts.attemptNumber);
}
