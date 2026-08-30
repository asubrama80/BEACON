/**
 * Direct tests of the Module 10 dispatch engine against a live PostgreSQL database — exercises
 * claim idempotency, retry/failure classification, and attempt-history correctness using mock
 * providers with test-injected outcome resolvers (never reachable via any request/config path;
 * see providers/mockProvider.ts). Skipped when DATABASE_URL isn't reachable.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, alerts, alertRecipients, notificationDispatchAttempts, contacts, type Database } from "@beacon/database";
import { dispatchRecipients } from "../../modules/notifications/dispatchEngine.js";
import {
  claimRecipientForDispatch,
  getPendingRecipients,
  getRecipientStatusCounts,
  listAttemptsForRecipient,
  type RecipientToDispatch,
} from "../../modules/notifications/dispatchQueries.js";
import { createMockSmsProvider, createMockEmailProvider, type MockOutcomeResolver } from "../../modules/notifications/providers/mockProvider.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("dispatch engine (live database)", () => {
  const db: Database = getDb();
  const createdAlertIds: string[] = [];
  const createdContactIds: string[] = [];

  afterAll(async () => {
    for (const id of createdAlertIds) {
      await db.delete(notificationDispatchAttempts).where(eq(notificationDispatchAttempts.alertId, id));
      await db.delete(alertRecipients).where(eq(alertRecipients.alertId, id));
      await db.delete(alerts).where(eq(alerts.id, id));
    }
    for (const id of createdContactIds) {
      await db.delete(contacts).where(eq(contacts.id, id));
    }
  });

  const FAST_CONFIG = { maxAttempts: 3, retryBaseMs: 5, concurrency: 3, providerTimeoutMs: 2000 };

  async function seedReadyAlert(recipientCount: number): Promise<{ alertId: string; recipientIds: string[] }> {
    const [alert] = await db
      .insert(alerts)
      .values({
        alertNumber: `ALT-TEST-${randomUUID().slice(0, 8)}`,
        title: "Dispatch engine test alert",
        channel: "sms",
        contentSource: "adhoc",
        subject: null,
        body: "Hi {{firstName}}",
        status: "ready",
        eligibleRecipientCount: recipientCount,
        excludedCount: 0,
      })
      .returning({ id: alerts.id });
    createdAlertIds.push(alert!.id);

    const recipientIds: string[] = [];
    for (let i = 0; i < recipientCount; i += 1) {
      const [contact] = await db
        .insert(contacts)
        .values({ firstName: `Engine${i}`, lastName: "Test", mobilePhone: `+1555000${i}${randomUUID().slice(0, 4)}` })
        .returning({ id: contacts.id, mobilePhone: contacts.mobilePhone });
      createdContactIds.push(contact!.id);

      const [recipient] = await db
        .insert(alertRecipients)
        .values({
          alertId: alert!.id,
          contactId: contact!.id,
          recipientName: `Engine${i} Test`,
          recipientAddress: contact!.mobilePhone,
          renderedBody: `Hi Engine${i}`,
          channel: "sms",
          status: "pending_delivery",
        })
        .returning({ id: alertRecipients.id });
      recipientIds.push(recipient!.id);
    }

    return { alertId: alert!.id, recipientIds };
  }

  it("submits successfully via the mock provider (always-accept default)", async () => {
    const { alertId, recipientIds } = await seedReadyAlert(1);
    const pending = await getPendingRecipients(db, alertId);

    await dispatchRecipients(db, alertId, pending, { sms: createMockSmsProvider(), email: createMockEmailProvider() }, FAST_CONFIG);

    const counts = await getRecipientStatusCounts(db, alertId);
    expect(counts.submitted).toBe(1);
    expect(counts.submissionFailed).toBe(0);

    const [row] = await db.select().from(alertRecipients).where(eq(alertRecipients.id, recipientIds[0]!));
    expect(row!.status).toBe("submitted");
    expect(row!.providerMessageId).toMatch(/^mock-mock-/);
    expect(row!.provider).toBe("mock");
    expect(row!.submittedAt).not.toBeNull();
  });

  it("retries a transient failure and eventually succeeds", async () => {
    const { alertId, recipientIds } = await seedReadyAlert(1);
    let calls = 0;
    const resolver: MockOutcomeResolver = () => {
      calls += 1;
      return calls < 2 ? { accepted: false, failureClass: "transient", errorCode: "simulated_timeout" } : { accepted: true };
    };

    const pending = await getPendingRecipients(db, alertId);
    await dispatchRecipients(db, alertId, pending, { sms: createMockSmsProvider(resolver), email: createMockEmailProvider() }, FAST_CONFIG);

    const [row] = await db.select().from(alertRecipients).where(eq(alertRecipients.id, recipientIds[0]!));
    expect(row!.status).toBe("submitted");
    expect(row!.attemptCount).toBe(2);

    const attempts = await listAttemptsForRecipient(db, recipientIds[0]!);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.status).toBe("submission_failed");
    expect(attempts[0]!.failureClass).toBe("transient");
    expect(attempts[1]!.status).toBe("submitted");
  });

  it("does not retry a permanent failure", async () => {
    const { alertId, recipientIds } = await seedReadyAlert(1);
    const resolver: MockOutcomeResolver = () => ({ accepted: false, failureClass: "permanent", errorCode: "invalid_destination" });

    const pending = await getPendingRecipients(db, alertId);
    await dispatchRecipients(db, alertId, pending, { sms: createMockSmsProvider(resolver), email: createMockEmailProvider() }, FAST_CONFIG);

    const [row] = await db.select().from(alertRecipients).where(eq(alertRecipients.id, recipientIds[0]!));
    expect(row!.status).toBe("submission_failed");
    expect(row!.attemptCount).toBe(1);
    expect(row!.lastFailureClass).toBe("permanent");

    const attempts = await listAttemptsForRecipient(db, recipientIds[0]!);
    expect(attempts).toHaveLength(1);
  });

  it("exhausts bounded retries on repeated transient failure and marks submission_failed", async () => {
    const { alertId, recipientIds } = await seedReadyAlert(1);
    const resolver: MockOutcomeResolver = () => ({ accepted: false, failureClass: "transient" });

    const pending = await getPendingRecipients(db, alertId);
    await dispatchRecipients(
      db,
      alertId,
      pending,
      { sms: createMockSmsProvider(resolver), email: createMockEmailProvider() },
      { ...FAST_CONFIG, maxAttempts: 2 },
    );

    const [row] = await db.select().from(alertRecipients).where(eq(alertRecipients.id, recipientIds[0]!));
    expect(row!.status).toBe("submission_failed");
    expect(row!.attemptCount).toBe(2);

    const attempts = await listAttemptsForRecipient(db, recipientIds[0]!);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.status === "submission_failed")).toBe(true);
  });

  it("partial success: one submitted, one permanent failure, one transient-then-success", async () => {
    const { alertId, recipientIds } = await seedReadyAlert(3);
    let cCalls = 0;
    const resolver: MockOutcomeResolver = ({ idempotencyKey }) => {
      if (idempotencyKey === recipientIds[0]) return { accepted: true };
      if (idempotencyKey === recipientIds[1]) return { accepted: false, failureClass: "permanent" };
      cCalls += 1;
      return cCalls < 2 ? { accepted: false, failureClass: "transient" } : { accepted: true };
    };

    const pending = await getPendingRecipients(db, alertId);
    const outcome = await dispatchRecipients(
      db,
      alertId,
      pending,
      { sms: createMockSmsProvider(resolver), email: createMockEmailProvider() },
      FAST_CONFIG,
    );

    expect(outcome.submitted).toBe(2);
    expect(outcome.submissionFailed).toBe(1);

    const counts = await getRecipientStatusCounts(db, alertId);
    expect(counts.submitted).toBe(2);
    expect(counts.submissionFailed).toBe(1);
    // Successful submissions are never rolled back because of a sibling's failure.
    const [a] = await db.select({ status: alertRecipients.status }).from(alertRecipients).where(eq(alertRecipients.id, recipientIds[0]!));
    expect(a!.status).toBe("submitted");
  });

  it("idempotent claim: a second sequential claim attempt on the same recipient is rejected", async () => {
    const { recipientIds } = await seedReadyAlert(1);
    const first = await claimRecipientForDispatch(db, recipientIds[0]!);
    const second = await claimRecipientForDispatch(db, recipientIds[0]!);
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it("idempotent claim under genuine concurrency: exactly one of two simultaneous claims wins", async () => {
    const { recipientIds } = await seedReadyAlert(1);
    const [a, b] = await Promise.all([
      claimRecipientForDispatch(db, recipientIds[0]!),
      claimRecipientForDispatch(db, recipientIds[0]!),
    ]);
    const winners = [a, b].filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
  });

  it("a recipient already claimed is skipped by dispatchRecipients rather than resubmitted", async () => {
    const { alertId, recipientIds } = await seedReadyAlert(1);
    await claimRecipientForDispatch(db, recipientIds[0]!);

    const recipient: RecipientToDispatch = {
      id: recipientIds[0]!,
      channel: "sms",
      destination: "+15550000000",
      renderedSubject: null,
      renderedBody: "Hi",
    };
    const outcome = await dispatchRecipients(db, alertId, [recipient], { sms: createMockSmsProvider(), email: createMockEmailProvider() }, FAST_CONFIG);

    expect(outcome.submitted).toBe(0);
    expect(outcome.skipped).toBe(1);
    const attempts = await listAttemptsForRecipient(db, recipientIds[0]!);
    expect(attempts).toHaveLength(0);
  });

  it("attempt history never contains destination, body, or credentials", async () => {
    const { alertId, recipientIds } = await seedReadyAlert(1);
    const pending = await getPendingRecipients(db, alertId);
    await dispatchRecipients(db, alertId, pending, { sms: createMockSmsProvider(), email: createMockEmailProvider() }, FAST_CONFIG);

    const attempts = await listAttemptsForRecipient(db, recipientIds[0]!);
    const serialized = JSON.stringify(attempts);
    expect(serialized).not.toContain("+1555");
    expect(serialized).not.toContain("Hi Engine");
    expect(serialized).not.toMatch(/token|secret|password/i);
  });
});
