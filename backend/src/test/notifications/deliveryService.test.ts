/**
 * Direct tests of the Module 11 delivery-tracking service against a live PostgreSQL database —
 * event correlation, idempotent dedupe, out-of-order/terminal-state precedence, and completion
 * detection. Skipped when DATABASE_URL isn't reachable.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  getDb,
  alerts,
  alertRecipients,
  notificationDeliveryEvents,
  incidents,
  incidentTimelineEvents,
  auditLogs,
  contacts,
  type Database,
} from "@beacon/database";
import { processDeliveryEvent } from "../../modules/notifications/deliveryService.js";
import { getDeliverySummary, listDeliveryEventsForRecipient } from "../../modules/notifications/deliveryQueries.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("delivery service (live database)", () => {
  const db: Database = getDb();
  const createdAlertIds: string[] = [];
  const createdContactIds: string[] = [];
  const createdIncidentIds: string[] = [];

  afterAll(async () => {
    for (const id of createdAlertIds) {
      await db.delete(auditLogs).where(eq(auditLogs.resourceId, id));
      await db.delete(notificationDeliveryEvents).where(eq(notificationDeliveryEvents.alertId, id));
      await db.delete(alertRecipients).where(eq(alertRecipients.alertId, id));
      await db.delete(alerts).where(eq(alerts.id, id));
    }
    for (const id of createdIncidentIds) {
      await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
      await db.delete(incidentTimelineEvents).where(eq(incidentTimelineEvents.incidentId, id));
      await db.delete(incidents).where(eq(incidents.id, id));
    }
    for (const id of createdContactIds) {
      await db.delete(contacts).where(eq(contacts.id, id));
    }
  });

  async function seedSubmittedAlert(
    recipientCount: number,
    overrides: { incidentId?: string } = {},
  ): Promise<{ alertId: string; recipientIds: string[]; providerMessageIds: string[] }> {
    const [alert] = await db
      .insert(alerts)
      .values({
        alertNumber: `ALT-TEST-${randomUUID().slice(0, 8)}`,
        title: "Delivery service test alert",
        incidentId: overrides.incidentId,
        channel: "sms",
        contentSource: "adhoc",
        body: "Hi {{firstName}}",
        status: "ready",
        eligibleRecipientCount: recipientCount,
        excludedCount: 0,
      })
      .returning({ id: alerts.id });
    createdAlertIds.push(alert!.id);

    const recipientIds: string[] = [];
    const providerMessageIds: string[] = [];
    for (let i = 0; i < recipientCount; i += 1) {
      const [contact] = await db
        .insert(contacts)
        .values({ firstName: `Delivery${i}`, lastName: "Test", mobilePhone: `+1555001${i}${randomUUID().slice(0, 4)}` })
        .returning({ id: contacts.id, mobilePhone: contacts.mobilePhone });
      createdContactIds.push(contact!.id);

      const providerMessageId = `test-msg-${randomUUID()}`;
      providerMessageIds.push(providerMessageId);
      const [recipient] = await db
        .insert(alertRecipients)
        .values({
          alertId: alert!.id,
          contactId: contact!.id,
          recipientName: `Delivery${i} Test`,
          recipientAddress: contact!.mobilePhone,
          renderedBody: `Hi Delivery${i}`,
          channel: "sms",
          status: "submitted",
          provider: "mock",
          providerMessageId,
          submittedAt: new Date(),
          deliveryStatus: "pending",
          deliveryUpdatedAt: new Date(),
        })
        .returning({ id: alertRecipients.id });
      recipientIds.push(recipient!.id);
    }

    return { alertId: alert!.id, recipientIds, providerMessageIds };
  }

  it("processes a delivered event and correlates by (provider, providerMessageId)", async () => {
    const { recipientIds, providerMessageIds } = await seedSubmittedAlert(1);
    const outcome = await processDeliveryEvent(db, {
      provider: "mock",
      providerMessageId: providerMessageIds[0]!,
      rawProviderStatus: "delivered",
      normalizedStatus: "delivered",
      occurredAt: new Date(),
    });
    expect(outcome).toBe("processed");

    const [row] = await db.select().from(alertRecipients).where(eq(alertRecipients.id, recipientIds[0]!));
    expect(row!.deliveryStatus).toBe("delivered");
    expect(row!.deliveredAt).not.toBeNull();
  });

  it("returns unknown_recipient for an uncorrelatable providerMessageId, never inventing a recipient", async () => {
    const outcome = await processDeliveryEvent(db, {
      provider: "mock",
      providerMessageId: `does-not-exist-${randomUUID()}`,
      rawProviderStatus: "delivered",
      normalizedStatus: "delivered",
      occurredAt: new Date(),
    });
    expect(outcome).toBe("unknown_recipient");
  });

  it("is idempotent: the exact same event processed twice yields one history row and one state transition", async () => {
    const { recipientIds, providerMessageIds } = await seedSubmittedAlert(1);
    const event = {
      provider: "mock",
      providerMessageId: providerMessageIds[0]!,
      rawProviderStatus: "delivered",
      normalizedStatus: "delivered" as const,
      occurredAt: new Date(),
    };
    const first = await processDeliveryEvent(db, event);
    const second = await processDeliveryEvent(db, event);
    expect(first).toBe("processed");
    expect(second).toBe("duplicate");

    const events = await listDeliveryEventsForRecipient(db, recipientIds[0]!);
    expect(events).toHaveLength(1);
  });

  it("out-of-order: a DELIVERED event followed by an older SUBMITTED-equivalent event does not regress current state", async () => {
    const { recipientIds, providerMessageIds } = await seedSubmittedAlert(1);
    await processDeliveryEvent(db, {
      provider: "mock",
      providerMessageId: providerMessageIds[0]!,
      rawProviderStatus: "delivered",
      normalizedStatus: "delivered",
      occurredAt: new Date(),
    });
    // A stale "submitted"-type re-confirmation arriving after the terminal DELIVERED event.
    await processDeliveryEvent(db, {
      provider: "mock",
      providerMessageId: providerMessageIds[0]!,
      rawProviderStatus: "sent",
      normalizedStatus: "submitted",
      occurredAt: new Date(Date.now() - 60_000),
    });

    const [row] = await db.select().from(alertRecipients).where(eq(alertRecipients.id, recipientIds[0]!));
    expect(row!.deliveryStatus).toBe("delivered");

    const events = await listDeliveryEventsForRecipient(db, recipientIds[0]!);
    expect(events).toHaveLength(2); // both events are still recorded in history
  });

  it("terminal states never regress: BOUNCED then a duplicate BOUNCED does not mutate state twice", async () => {
    const { recipientIds, providerMessageIds } = await seedSubmittedAlert(1);
    await processDeliveryEvent(db, {
      provider: "mock",
      providerMessageId: providerMessageIds[0]!,
      rawProviderStatus: "Bounce",
      normalizedStatus: "bounced",
      occurredAt: new Date(),
    });
    const [afterFirst] = await db.select({ deliveryUpdatedAt: alertRecipients.deliveryUpdatedAt }).from(alertRecipients).where(eq(alertRecipients.id, recipientIds[0]!));
    expect(afterFirst!.deliveryUpdatedAt).not.toBeNull();

    // Genuinely duplicate provider event id -> deduped, never reaches the update step at all.
    await processDeliveryEvent(db, {
      provider: "mock",
      providerMessageId: providerMessageIds[0]!,
      providerEventId: "same-feedback-id",
      rawProviderStatus: "Bounce",
      normalizedStatus: "bounced",
      occurredAt: new Date(),
    });
    await processDeliveryEvent(db, {
      provider: "mock",
      providerMessageId: providerMessageIds[0]!,
      providerEventId: "same-feedback-id",
      rawProviderStatus: "Bounce",
      normalizedStatus: "bounced",
      occurredAt: new Date(),
    });

    const [row] = await db.select().from(alertRecipients).where(eq(alertRecipients.id, recipientIds[0]!));
    expect(row!.deliveryStatus).toBe("bounced");

    const events = await listDeliveryEventsForRecipient(db, recipientIds[0]!);
    // First bounced (dedupe key by msg+status) + one distinct-event-id bounced = 2 total (the
    // second identical-event-id call is deduped).
    expect(events).toHaveLength(2);
  });

  it("completion: fires exactly once when the final submitted recipient reaches a terminal state", async () => {
    const incidentTitle = `Delivery Completion Incident ${randomUUID().slice(0, 6)}`;
    const [incident] = await db.insert(incidents).values({ incidentNumber: `INC-TEST-${randomUUID().slice(0, 8)}`, title: incidentTitle, severity: "warning", status: "active" }).returning({ id: incidents.id });
    createdIncidentIds.push(incident!.id);

    const { alertId, providerMessageIds } = await seedSubmittedAlert(3, { incidentId: incident!.id });

    await processDeliveryEvent(db, { provider: "mock", providerMessageId: providerMessageIds[0]!, rawProviderStatus: "delivered", normalizedStatus: "delivered", occurredAt: new Date() });
    let [alertRow] = await db.select({ deliveryCompletedAt: alerts.deliveryCompletedAt }).from(alerts).where(eq(alerts.id, alertId));
    expect(alertRow!.deliveryCompletedAt).toBeNull();

    await processDeliveryEvent(db, { provider: "mock", providerMessageId: providerMessageIds[1]!, rawProviderStatus: "delivered", normalizedStatus: "delivered", occurredAt: new Date() });
    [alertRow] = await db.select({ deliveryCompletedAt: alerts.deliveryCompletedAt }).from(alerts).where(eq(alerts.id, alertId));
    expect(alertRow!.deliveryCompletedAt).toBeNull();

    await processDeliveryEvent(db, { provider: "mock", providerMessageId: providerMessageIds[2]!, rawProviderStatus: "failed", normalizedStatus: "failed", occurredAt: new Date() });
    [alertRow] = await db.select({ deliveryCompletedAt: alerts.deliveryCompletedAt }).from(alerts).where(eq(alerts.id, alertId));
    expect(alertRow!.deliveryCompletedAt).not.toBeNull();

    const timeline = await db.select().from(incidentTimelineEvents).where(eq(incidentTimelineEvents.incidentId, incident!.id));
    const completionEvents = timeline.filter((e) => e.eventType === "ALERT_DELIVERY_COMPLETED");
    expect(completionEvents).toHaveLength(1);

    const audit = await db.select().from(auditLogs).where(eq(auditLogs.resourceId, alertId));
    const completionAudit = audit.filter((a) => a.eventType === "ALERT_DELIVERY_COMPLETED");
    expect(completionAudit).toHaveLength(1);

    // A later duplicate/repeated callback for an already-terminal recipient must not fire a
    // second completion event.
    await processDeliveryEvent(db, { provider: "mock", providerMessageId: providerMessageIds[0]!, rawProviderStatus: "delivered", normalizedStatus: "delivered", occurredAt: new Date() });
    const timelineAfter = await db.select().from(incidentTimelineEvents).where(eq(incidentTimelineEvents.incidentId, incident!.id));
    expect(timelineAfter.filter((e) => e.eventType === "ALERT_DELIVERY_COMPLETED")).toHaveLength(1);
  });

  it("partial delivery summary reflects exact counts and never claims completion while pending remains", async () => {
    const { alertId, providerMessageIds } = await seedSubmittedAlert(4);
    await processDeliveryEvent(db, { provider: "mock", providerMessageId: providerMessageIds[0]!, rawProviderStatus: "delivered", normalizedStatus: "delivered", occurredAt: new Date() });
    await processDeliveryEvent(db, { provider: "mock", providerMessageId: providerMessageIds[1]!, rawProviderStatus: "delivered", normalizedStatus: "delivered", occurredAt: new Date() });
    await processDeliveryEvent(db, { provider: "mock", providerMessageId: providerMessageIds[2]!, rawProviderStatus: "failed", normalizedStatus: "failed", occurredAt: new Date() });
    // providerMessageIds[3] left pending — never processed.

    const summary = await getDeliverySummary(db, alertId);
    expect(summary).toMatchObject({ total: 4, delivered: 2, failed: 1, deliveryPending: 1, bounced: 0, undelivered: 0 });

    const [alertRow] = await db.select({ deliveryCompletedAt: alerts.deliveryCompletedAt }).from(alerts).where(eq(alerts.id, alertId));
    expect(alertRow!.deliveryCompletedAt).toBeNull();
  });

  it("attempt-free delivery event history contains no destination/body/credentials", async () => {
    const { providerMessageIds } = await seedSubmittedAlert(1);
    await processDeliveryEvent(db, {
      provider: "mock",
      providerMessageId: providerMessageIds[0]!,
      rawProviderStatus: "delivered",
      normalizedStatus: "delivered",
      occurredAt: new Date(),
    });
    const rows = await db.select().from(notificationDeliveryEvents).where(eq(notificationDeliveryEvents.providerMessageId, providerMessageIds[0]!));
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain("+1555");
    expect(serialized).not.toContain("Hi Delivery");
    expect(serialized).not.toMatch(/token|secret|password/i);
  });
});
