/**
 * Tests for the SES/SNS event-ingestion webhook and its SNS message-authenticity verification.
 * No real AWS account required — signatures are computed against a synthetic RSA keypair and
 * verified via the handler's injectable `fetchCert` seam, which returns the synthetic public key
 * in place of fetching a real AWS-hosted certificate. Skipped when DATABASE_URL isn't reachable.
 */
import { randomUUID, generateKeyPairSync, createSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, alerts, alertRecipients, notificationDeliveryEvents, contacts, type Database } from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { buildStringToSign, isTrustedSnsCertUrl, verifySnsSignature, type SnsMessage } from "../../modules/notifications/webhooks/snsSignature.js";
import { mapSesEvent, type SesEventEnvelope } from "../../modules/notifications/webhooks/sesWebhook.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SYNTHETIC_CERT_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;
const TRUSTED_CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-synthetic.pem";

async function syntheticFetchCert(url: string): Promise<string> {
  if (url !== TRUSTED_CERT_URL) throw new Error("unexpected cert URL requested in test");
  return SYNTHETIC_CERT_PEM;
}

function signSns(msg: Omit<SnsMessage, "Signature">): SnsMessage {
  const signer = createSign("RSA-SHA1");
  signer.update(buildStringToSign(msg as SnsMessage), "utf8");
  return { ...msg, Signature: signer.sign(privateKey, "base64") };
}

function notification(message: string, overrides: Partial<SnsMessage> = {}): SnsMessage {
  const base: Omit<SnsMessage, "Signature"> = {
    Type: "Notification",
    MessageId: randomUUID(),
    TopicArn: "arn:aws:sns:us-east-1:123456789012:ses-delivery-events",
    Message: message,
    Timestamp: new Date().toISOString(),
    SignatureVersion: "1",
    SigningCertURL: TRUSTED_CERT_URL,
    ...overrides,
  };
  return signSns(base);
}

describe("SNS signature verification (synthetic keypair, no real AWS account)", () => {
  it("accepts a message with a genuine signature from a trusted cert URL", async () => {
    const msg = notification(JSON.stringify({ eventType: "Delivery" }));
    expect(await verifySnsSignature(msg, syntheticFetchCert)).toBe(true);
  });

  it("rejects a tampered message body even though the signature field is unchanged", async () => {
    const msg = notification(JSON.stringify({ eventType: "Delivery" }));
    const tampered: SnsMessage = { ...msg, Message: JSON.stringify({ eventType: "Bounce" }) };
    expect(await verifySnsSignature(tampered, syntheticFetchCert)).toBe(false);
  });

  it("rejects an unsupported SignatureVersion", async () => {
    const msg = notification(JSON.stringify({ eventType: "Delivery" }), { SignatureVersion: "2" });
    expect(await verifySnsSignature(msg, syntheticFetchCert)).toBe(false);
  });

  it("rejects a cert URL that is not a genuine AWS SNS hostname (no network call is ever made)", async () => {
    const msg = notification(JSON.stringify({ eventType: "Delivery" }), {
      SigningCertURL: "https://sns.us-east-1.amazonaws.com.attacker.example/cert.pem",
    });
    let fetchCalled = false;
    const result = await verifySnsSignature(msg, async (url) => {
      fetchCalled = true;
      return syntheticFetchCert(url);
    });
    expect(result).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  it("isTrustedSnsCertUrl accepts genuine SNS hostnames and rejects lookalikes", () => {
    expect(isTrustedSnsCertUrl("https://sns.us-east-1.amazonaws.com/cert.pem")).toBe(true);
    expect(isTrustedSnsCertUrl("http://sns.us-east-1.amazonaws.com/cert.pem")).toBe(false); // not https
    expect(isTrustedSnsCertUrl("https://sns.us-east-1.amazonaws.com.evil.example/cert.pem")).toBe(false);
    expect(isTrustedSnsCertUrl("https://evil.example/sns.us-east-1.amazonaws.com")).toBe(false);
    expect(isTrustedSnsCertUrl("not-a-url")).toBe(false);
  });
});

describe("SES event mapping (unit)", () => {
  it("maps a Delivery event to delivered", () => {
    const event: SesEventEnvelope = { eventType: "Delivery", mail: { messageId: "m1" }, delivery: { timestamp: "2026-01-01T00:00:00.000Z" } };
    const mapped = mapSesEvent(event);
    expect(mapped?.normalizedStatus).toBe("delivered");
    expect(mapped?.occurredAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("maps a Bounce event to bounced with a safe error summary and no raw payload", () => {
    const event: SesEventEnvelope = {
      eventType: "Bounce",
      mail: { messageId: "m2" },
      bounce: { bounceType: "Permanent", bounceSubType: "General", timestamp: "2026-01-01T00:00:00.000Z", feedbackId: "fb-1" },
    };
    const mapped = mapSesEvent(event);
    expect(mapped).toMatchObject({ normalizedStatus: "bounced", providerErrorCode: "Permanent", safeErrorSummary: "Permanent/General", providerEventId: "fb-1" });
  });

  it("maps a Reject event to failed", () => {
    const event: SesEventEnvelope = { eventType: "Reject", mail: { messageId: "m3" }, reject: { reason: "Bad content" } };
    const mapped = mapSesEvent(event);
    expect(mapped).toMatchObject({ normalizedStatus: "failed", providerErrorCode: "Bad content" });
  });

  it("does not map an irrelevant event type (e.g. Send/Open/Click)", () => {
    expect(mapSesEvent({ eventType: "Open", mail: { messageId: "m4" } })).toBeUndefined();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("SES/SNS webhook route (live database)", () => {
  const app = buildTestApp({}, { sesFetchCert: syntheticFetchCert });
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

  async function seedSubmittedRecipient(): Promise<{ recipientId: string; messageId: string }> {
    const [alert] = await db
      .insert(alerts)
      .values({
        alertNumber: `ALT-SES-${randomUUID().slice(0, 8)}`,
        title: "SES webhook test alert",
        channel: "email",
        contentSource: "adhoc",
        subject: "Test",
        body: "Hi",
        status: "ready",
        eligibleRecipientCount: 1,
        excludedCount: 0,
      })
      .returning({ id: alerts.id });
    createdAlertIds.push(alert!.id);

    const [contact] = await db
      .insert(contacts)
      .values({ firstName: "Ses", lastName: "Test", email: `ses-${randomUUID()}@example.invalid` })
      .returning({ id: contacts.id, email: contacts.email });
    createdContactIds.push(contact!.id);

    const messageId = randomUUID();
    const [recipient] = await db
      .insert(alertRecipients)
      .values({
        alertId: alert!.id,
        contactId: contact!.id,
        recipientName: "Ses Test",
        recipientAddress: contact!.email,
        renderedSubject: "Test",
        renderedBody: "Hi",
        channel: "email",
        status: "submitted",
        provider: "ses",
        providerMessageId: messageId,
        submittedAt: new Date(),
        deliveryStatus: "pending",
        deliveryUpdatedAt: new Date(),
      })
      .returning({ id: alertRecipients.id });
    return { recipientId: recipient!.id, messageId };
  }

  async function postSnsEnvelope(envelope: SnsMessage) {
    return app.inject({
      method: "POST",
      url: "/webhooks/ses/events",
      headers: { "content-type": "text/plain" },
      payload: JSON.stringify(envelope),
    });
  }

  it("acknowledges SubscriptionConfirmation without ever fetching SubscribeURL (SSRF-safe by construction)", async () => {
    const envelope = notification("irrelevant", {
      Type: "SubscriptionConfirmation",
      SubscribeURL: "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc",
    });
    const response = await postSnsEnvelope(envelope);
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe("subscription_ack_no_fetch");
  });

  it("acknowledges UnsubscribeConfirmation the same way", async () => {
    const envelope = notification("irrelevant", { Type: "UnsubscribeConfirmation" });
    const response = await postSnsEnvelope(envelope);
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe("subscription_ack_no_fetch");
  });

  it("ignores a non-Notification, non-confirmation type safely", async () => {
    const envelope = notification("irrelevant", { Type: "SomethingElse" });
    const response = await postSnsEnvelope(envelope);
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe("ignored_type");
  });

  it("rejects a Notification with an untrusted cert URL, never making a network request", async () => {
    const { messageId } = await seedSubmittedRecipient();
    const envelope = notification(JSON.stringify({ eventType: "Delivery", mail: { messageId }, delivery: { timestamp: new Date().toISOString() } }), {
      SigningCertURL: "https://evil.example/cert.pem",
    });
    const response = await postSnsEnvelope(envelope);
    expect(response.statusCode).toBe(403);
  });

  it("rejects invalid JSON payloads", async () => {
    const response = await app.inject({ method: "POST", url: "/webhooks/ses/events", headers: { "content-type": "text/plain" }, payload: "{not json" });
    expect(response.statusCode).toBe(400);
  });

  it("processes a valid Delivery notification end-to-end", async () => {
    const { recipientId, messageId } = await seedSubmittedRecipient();
    const envelope = notification(JSON.stringify({ eventType: "Delivery", mail: { messageId }, delivery: { timestamp: new Date().toISOString() } }));
    const response = await postSnsEnvelope(envelope);
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe("processed");

    const [row] = await db.select({ deliveryStatus: alertRecipients.deliveryStatus }).from(alertRecipients).where(eq(alertRecipients.id, recipientId));
    expect(row!.deliveryStatus).toBe("delivered");
  });

  it("processes a valid Bounce notification end-to-end", async () => {
    const { recipientId, messageId } = await seedSubmittedRecipient();
    const envelope = notification(
      JSON.stringify({
        eventType: "Bounce",
        mail: { messageId },
        bounce: { bounceType: "Permanent", bounceSubType: "General", timestamp: new Date().toISOString(), feedbackId: `fb-${randomUUID()}` },
      }),
    );
    const response = await postSnsEnvelope(envelope);
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe("processed");

    const [row] = await db.select({ deliveryStatus: alertRecipients.deliveryStatus }).from(alertRecipients).where(eq(alertRecipients.id, recipientId));
    expect(row!.deliveryStatus).toBe("bounced");
  });

  it("processes a valid Reject notification end-to-end as failed", async () => {
    const { recipientId, messageId } = await seedSubmittedRecipient();
    const envelope = notification(JSON.stringify({ eventType: "Reject", mail: { messageId }, reject: { reason: "Bad content" } }));
    const response = await postSnsEnvelope(envelope);
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe("processed");

    const [row] = await db.select({ deliveryStatus: alertRecipients.deliveryStatus }).from(alertRecipients).where(eq(alertRecipients.id, recipientId));
    expect(row!.deliveryStatus).toBe("failed");
  });

  it("returns a safe 200 for an unknown messageId, never inventing a recipient", async () => {
    const envelope = notification(
      JSON.stringify({ eventType: "Delivery", mail: { messageId: randomUUID() }, delivery: { timestamp: new Date().toISOString() } }),
    );
    const response = await postSnsEnvelope(envelope);
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe("unknown_recipient");
  });

  it("a duplicate notification (same MessageId) is acknowledged without a duplicate delivery event", async () => {
    const { recipientId, messageId } = await seedSubmittedRecipient();
    const sesEvent = JSON.stringify({ eventType: "Delivery", mail: { messageId }, delivery: { timestamp: new Date().toISOString() } });
    const base: Omit<SnsMessage, "Signature"> = {
      Type: "Notification",
      MessageId: randomUUID(),
      TopicArn: "arn:aws:sns:us-east-1:123456789012:ses-delivery-events",
      Message: sesEvent,
      Timestamp: new Date().toISOString(),
      SignatureVersion: "1",
      SigningCertURL: TRUSTED_CERT_URL,
    };
    const envelope = signSns(base);

    const first = await postSnsEnvelope(envelope);
    const second = await postSnsEnvelope(envelope);
    expect(first.json().outcome).toBe("processed");
    expect(second.json().outcome).toBe("duplicate");

    const events = await db.select().from(notificationDeliveryEvents).where(eq(notificationDeliveryEvents.alertRecipientId, recipientId));
    expect(events).toHaveLength(1);
  });
});
