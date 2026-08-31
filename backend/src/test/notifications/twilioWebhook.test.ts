/**
 * HTTP-level tests for the Twilio status-callback webhook against a live PostgreSQL database.
 * No real Twilio credentials required — signatures are computed with a synthetic auth token using
 * the same HMAC-SHA1 algorithm Twilio uses, so both valid and invalid signatures are fully
 * testable locally. Skipped when DATABASE_URL isn't reachable.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, alerts, alertRecipients, notificationDeliveryEvents, contacts, type Database } from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { computeTwilioSignature } from "../../modules/notifications/webhooks/twilioSignature.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

const AUTH_TOKEN = "test-twilio-auth-token";
const PUBLIC_BASE_URL = "https://beacon.example.invalid";
const CALLBACK_URL = `${PUBLIC_BASE_URL}/webhooks/twilio/status`;

describe.skipIf(!process.env.DATABASE_URL)("Twilio status webhook (live database)", () => {
  const app = buildTestApp({
    TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    TWILIO_FROM_NUMBER: "+15005550006",
    PUBLIC_BASE_URL,
  });
  const db: Database = getDb();
  const createdAlertIds: string[] = [];
  const createdContactIds: string[] = [];

  afterAll(async () => {
    for (const id of createdAlertIds) {
      await db.delete(notificationDeliveryEvents).where(eq(notificationDeliveryEvents.alertId, id));
      await db.delete(alertRecipients).where(eq(alertRecipients.alertId, id));
      await db.delete(alerts).where(eq(alerts.id, id));
    }
    for (const id of createdContactIds) {
      await db.delete(contacts).where(eq(contacts.id, id));
    }
    await app.close();
  });

  async function seedSubmittedRecipient(): Promise<{ recipientId: string; messageSid: string }> {
    const [alert] = await db
      .insert(alerts)
      .values({
        alertNumber: `ALT-TW-${randomUUID().slice(0, 8)}`,
        title: "Twilio webhook test alert",
        channel: "sms",
        contentSource: "adhoc",
        body: "Hi",
        status: "ready",
        eligibleRecipientCount: 1,
        excludedCount: 0,
      })
      .returning({ id: alerts.id });
    createdAlertIds.push(alert!.id);

    const [contact] = await db
      .insert(contacts)
      .values({ firstName: "Twilio", lastName: "Test", mobilePhone: `+1555${randomUUID().slice(0, 7).padStart(7, "0")}` })
      .returning({ id: contacts.id, mobilePhone: contacts.mobilePhone });
    createdContactIds.push(contact!.id);

    const messageSid = `SM${randomUUID().replace(/-/g, "")}`;
    const [recipient] = await db
      .insert(alertRecipients)
      .values({
        alertId: alert!.id,
        contactId: contact!.id,
        recipientName: "Twilio Test",
        recipientAddress: contact!.mobilePhone,
        renderedBody: "Hi",
        channel: "sms",
        status: "submitted",
        provider: "twilio",
        providerMessageId: messageSid,
        submittedAt: new Date(),
        deliveryStatus: "pending",
        deliveryUpdatedAt: new Date(),
      })
      .returning({ id: alertRecipients.id });
    return { recipientId: recipient!.id, messageSid };
  }

  function sign(params: Record<string, string>): string {
    return computeTwilioSignature(AUTH_TOKEN, CALLBACK_URL, params);
  }

  async function postCallback(params: Record<string, string>, signature?: string) {
    const body = new URLSearchParams(params).toString();
    return app.inject({
      method: "POST",
      url: "/webhooks/twilio/status",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature ?? sign(params),
      },
      payload: body,
    });
  }

  it("rejects a request with an invalid signature", async () => {
    const { messageSid } = await seedSubmittedRecipient();
    const response = await postCallback({ MessageSid: messageSid, MessageStatus: "delivered" }, "clearly-invalid-signature");
    expect(response.statusCode).toBe(403);
  });

  it("rejects a request with no signature header at all", async () => {
    const { messageSid } = await seedSubmittedRecipient();
    const body = new URLSearchParams({ MessageSid: messageSid, MessageStatus: "delivered" }).toString();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/twilio/status",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: body,
    });
    expect(response.statusCode).toBe(403);
  });

  it("Module 24 — a validly-signed but malformed payload (missing MessageStatus) is rejected safely, not mistaken for a signature failure", async () => {
    const response = await postCallback({ MessageSid: `SM${randomUUID().replace(/-/g, "")}` });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_payload");
  });

  it("Module 24 — a validly-signed but malformed payload (missing MessageSid) is rejected safely", async () => {
    const response = await postCallback({ MessageStatus: "delivered" });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_payload");
  });

  it.each([
    ["queued", "submitted"],
    ["sending", "submitted"],
    ["sent", "submitted"],
    ["accepted", "submitted"],
    ["delivered", "delivered"],
    ["undelivered", "undelivered"],
    ["failed", "failed"],
  ])("maps Twilio status %s to normalized status %s", async (twilioStatus, expectedNormalized) => {
    const { recipientId, messageSid } = await seedSubmittedRecipient();
    const response = await postCallback({ MessageSid: messageSid, MessageStatus: twilioStatus });
    expect(response.statusCode).toBe(200);

    const [row] = await db
      .select({ deliveryStatus: alertRecipients.deliveryStatus })
      .from(alertRecipients)
      .where(eq(alertRecipients.id, recipientId));

    if (expectedNormalized === "submitted") {
      // "submitted" is not itself a DeliveryStatus (delivery_status starts at "pending" and only
      // moves on actual delivery outcomes) — the event is still recorded, but the outcome is
      // "no_op" rather than "processed", and delivery_status stays "pending".
      expect(response.json().outcome).toBe("no_op");
      expect(row!.deliveryStatus).toBe("pending");
    } else {
      expect(response.json().outcome).toBe("processed");
      expect(row!.deliveryStatus).toBe(expectedNormalized);
    }
  });

  it("acknowledges an unrecognized status without processing it", async () => {
    const { messageSid } = await seedSubmittedRecipient();
    const response = await postCallback({ MessageSid: messageSid, MessageStatus: "receiving" });
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe("ignored_status");
  });

  it("returns a safe 200 for an unknown MessageSid, never inventing a recipient", async () => {
    const response = await postCallback({ MessageSid: `SM${randomUUID().replace(/-/g, "")}`, MessageStatus: "delivered" });
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe("unknown_recipient");
  });

  it("a duplicate callback is acknowledged without a duplicate delivery event", async () => {
    const { recipientId, messageSid } = await seedSubmittedRecipient();
    const params = { MessageSid: messageSid, MessageStatus: "delivered" };
    const first = await postCallback(params);
    const second = await postCallback(params);
    expect(first.json().outcome).toBe("processed");
    expect(second.json().outcome).toBe("duplicate");
    expect(second.statusCode).toBe(200);

    const events = await db
      .select()
      .from(notificationDeliveryEvents)
      .where(eq(notificationDeliveryEvents.alertRecipientId, recipientId));
    expect(events).toHaveLength(1);
  });

  it("does not persist the callback's To/Body fields into delivery event history", async () => {
    const { recipientId, messageSid } = await seedSubmittedRecipient();
    const response = await postCallback({ MessageSid: messageSid, MessageStatus: "delivered", To: "+15551234567", Body: "secret body text" });
    expect(response.statusCode).toBe(200);

    const events = await db
      .select()
      .from(notificationDeliveryEvents)
      .where(eq(notificationDeliveryEvents.alertRecipientId, recipientId));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("+15551234567");
    expect(serialized).not.toContain("secret body text");
  });
});
