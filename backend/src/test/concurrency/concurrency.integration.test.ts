/**
 * Module 24's dedicated concurrency/race regression suite — genuine `Promise.all` simultaneous
 * requests against invariants that a sequential test can't prove. Scenarios already covered
 * elsewhere with true concurrency (last-admin race — Module 23's `security.integration.test.ts`;
 * concurrent OTP verify — `guestVerification.integration.test.ts`; concurrent participant
 * enrollment and Guest-removal-vs-Chat/War-Room races — `guestParticipant.integration.test.ts`;
 * concurrent Alert dispatch — `alerts/dispatch.integration.test.ts` and
 * `notifications/dispatchEngine.test.ts`) are not duplicated here. This file covers the remaining
 * gaps: concurrent duplicate Guest invitation creation, concurrent duplicate delivery webhook
 * callbacks (SES + Twilio), and concurrent Incident lifecycle transitions. Skipped when
 * DATABASE_URL isn't reachable.
 */
import { randomUUID, generateKeyPairSync, createSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  getDb,
  users,
  roles,
  userRoles,
  incidents,
  guestInvitations,
  incidentTimelineEvents,
  auditLogs,
  alerts,
  alertRecipients,
  notificationDeliveryEvents,
  contacts,
  type Database,
} from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";
import { computeTwilioSignature } from "../../modules/notifications/webhooks/twilioSignature.js";
import { buildStringToSign, type SnsMessage } from "../../modules/notifications/webhooks/snsSignature.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("concurrency / race regressions (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });

  describe("duplicate Guest invitation creation (concurrent)", () => {
    const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500", SMS_PROVIDER: "mock", EMAIL_PROVIDER: "mock" });
    const db: Database = getDb();
    const createdUserIds: string[] = [];
    const createdIncidentIds: string[] = [];

    // Deliberately never calls app.close(): buildApp()'s onClose hook tears down the process-wide
    // shared DB pool (closeDb()), and every describe block in this file has its own `const db =
    // getDb()` captured at collection time (before any test runs) — closing one app mid-file would
    // break every later describe's already-captured connection. Only rows are cleaned up here; the
    // app itself is never `.listen()`ed, so it holds no OS resources requiring explicit cleanup.
    afterAll(async () => {
      for (const id of createdIncidentIds) {
        await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
        await db.delete(incidentTimelineEvents).where(eq(incidentTimelineEvents.incidentId, id));
        await db.delete(guestInvitations).where(eq(guestInvitations.incidentId, id));
        await db.delete(incidents).where(eq(incidents.id, id));
      }
      for (const id of createdUserIds) {
        await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
        await db.delete(users).where(eq(users.id, id));
      }
    });

    async function createAdmin(): Promise<{ id: string; token: string; csrf: string }> {
      const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, "ADMIN")).limit(1);
      const email = `test-c24-admin-${randomUUID()}@example.invalid`;
      const passwordHash = await hashPassword("Correct-Horse-Battery-C24", config);
      const [row] = await db.insert(users).values({ email, displayName: "C24 Admin", passwordHash }).returning({ id: users.id });
      createdUserIds.push(row!.id);
      await db.insert(userRoles).values({ userId: row!.id, roleId: adminRole!.id });
      const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "Correct-Horse-Battery-C24" } });
      return {
        id: row!.id,
        token: response.cookies.find((c) => c.name === config.sessionCookieName)!.value,
        csrf: response.cookies.find((c) => c.name === config.csrfCookieName)!.value,
      };
    }

    function authHeaders(actor: { token: string; csrf: string }) {
      return {
        cookies: { [config.sessionCookieName]: actor.token, [config.csrfCookieName]: actor.csrf },
        headers: { "x-csrf-token": actor.csrf },
      };
    }

    it("two concurrent invitation requests to the same destination never both succeed", async () => {
      const admin = await createAdmin();
      const incidentResponse = await app.inject({
        method: "POST",
        url: "/incidents",
        ...authHeaders(admin),
        payload: { title: `C24 Invitation Race ${randomUUID().slice(0, 6)}`, severity: "warning" },
      });
      const incidentId = incidentResponse.json().incident.id as string;
      createdIncidentIds.push(incidentId);

      const destination = `c24-race-${randomUUID().slice(0, 8)}@example.invalid`;
      const [first, second] = await Promise.all([
        app.inject({
          method: "POST",
          url: `/incidents/${incidentId}/guest-invitations`,
          ...authHeaders(admin),
          payload: { guestName: "Race One", email: destination },
        }),
        app.inject({
          method: "POST",
          url: `/incidents/${incidentId}/guest-invitations`,
          ...authHeaders(admin),
          payload: { guestName: "Race Two", email: destination },
        }),
      ]);

      const statusCodes = [first.statusCode, second.statusCode].sort();
      expect(statusCodes).toEqual([201, 409]);

      const rows = await db.select().from(guestInvitations).where(eq(guestInvitations.incidentId, incidentId));
      const active = rows.filter((r) => r.status !== "revoked" && r.status !== "expired");
      expect(active).toHaveLength(1);
    });
  });

  describe("concurrent duplicate delivery webhook callbacks", () => {
    const AUTH_TOKEN = "test-twilio-auth-token-c24";
    const PUBLIC_BASE_URL = "https://beacon.example.invalid";
    const CALLBACK_URL = `${PUBLIC_BASE_URL}/webhooks/twilio/status`;

    const twilioApp = buildTestApp({
      TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      TWILIO_FROM_NUMBER: "+15005550006",
      PUBLIC_BASE_URL,
    });

    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const SYNTHETIC_CERT_PEM = publicKey.export({ type: "spki", format: "pem" }) as string;
    const TRUSTED_CERT_URL = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-synthetic-c24.pem";
    async function syntheticFetchCert(url: string): Promise<string> {
      if (url !== TRUSTED_CERT_URL) throw new Error("unexpected cert URL requested in test");
      return SYNTHETIC_CERT_PEM;
    }
    const sesApp = buildTestApp({}, { sesFetchCert: syntheticFetchCert });

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
      // Deliberately never closes twilioApp/sesApp — same reason as the describe block above:
      // closing mid-file would tear down the shared DB pool the next describe already captured a
      // reference to. Neither app is ever `.listen()`ed, so nothing leaks by skipping close().
    });

    async function seedSubmittedSmsRecipient(): Promise<{ recipientId: string; messageSid: string }> {
      const [alert] = await db
        .insert(alerts)
        .values({
          alertNumber: `ALT-C24-SMS-${randomUUID().slice(0, 8)}`,
          title: "C24 concurrency test alert",
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
        .values({ firstName: "C24", lastName: "Sms", mobilePhone: `+1555${randomUUID().slice(0, 7).padStart(7, "0")}` })
        .returning({ id: contacts.id, mobilePhone: contacts.mobilePhone });
      createdContactIds.push(contact!.id);
      const messageSid = `SM${randomUUID().replace(/-/g, "")}`;
      const [recipient] = await db
        .insert(alertRecipients)
        .values({
          alertId: alert!.id,
          contactId: contact!.id,
          recipientName: "C24 Sms",
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

    async function seedSubmittedEmailRecipient(): Promise<{ recipientId: string; messageId: string }> {
      const [alert] = await db
        .insert(alerts)
        .values({
          alertNumber: `ALT-C24-EMAIL-${randomUUID().slice(0, 8)}`,
          title: "C24 concurrency test alert",
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
        .values({ firstName: "C24", lastName: "Email", email: `c24-${randomUUID()}@example.invalid` })
        .returning({ id: contacts.id, email: contacts.email });
      createdContactIds.push(contact!.id);
      const messageId = randomUUID();
      const [recipient] = await db
        .insert(alertRecipients)
        .values({
          alertId: alert!.id,
          contactId: contact!.id,
          recipientName: "C24 Email",
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

    it("two genuinely concurrent identical Twilio callbacks produce exactly one delivery event", async () => {
      const { recipientId, messageSid } = await seedSubmittedSmsRecipient();
      const params = { MessageSid: messageSid, MessageStatus: "delivered" };
      const body = new URLSearchParams(params).toString();
      const signature = computeTwilioSignature(AUTH_TOKEN, CALLBACK_URL, params);

      const [first, second] = await Promise.all([
        twilioApp.inject({
          method: "POST",
          url: "/webhooks/twilio/status",
          headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
          payload: body,
        }),
        twilioApp.inject({
          method: "POST",
          url: "/webhooks/twilio/status",
          headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
          payload: body,
        }),
      ]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const outcomes = [first.json().outcome, second.json().outcome].sort();
      expect(outcomes).toEqual(["duplicate", "processed"]);

      const events = await db.select().from(notificationDeliveryEvents).where(eq(notificationDeliveryEvents.alertRecipientId, recipientId));
      expect(events).toHaveLength(1);
    });

    it("two genuinely concurrent identical SES/SNS delivery notifications produce exactly one delivery event", async () => {
      const { recipientId, messageId } = await seedSubmittedEmailRecipient();

      function signSns(msg: Omit<SnsMessage, "Signature">): SnsMessage {
        const signer = createSign("RSA-SHA1");
        signer.update(buildStringToSign(msg as SnsMessage), "utf8");
        return { ...msg, Signature: signer.sign(privateKey, "base64") };
      }

      const envelope = signSns({
        Type: "Notification",
        MessageId: randomUUID(),
        TopicArn: "arn:aws:sns:us-east-1:123456789012:ses-delivery-events",
        Message: JSON.stringify({ eventType: "Delivery", mail: { messageId }, delivery: { timestamp: new Date().toISOString() } }),
        Timestamp: new Date().toISOString(),
        SignatureVersion: "1",
        SigningCertURL: TRUSTED_CERT_URL,
      });
      const payload = JSON.stringify(envelope);

      const [first, second] = await Promise.all([
        sesApp.inject({ method: "POST", url: "/webhooks/ses/events", headers: { "content-type": "text/plain" }, payload }),
        sesApp.inject({ method: "POST", url: "/webhooks/ses/events", headers: { "content-type": "text/plain" }, payload }),
      ]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const outcomes = [first.json().outcome, second.json().outcome].sort();
      expect(outcomes).toEqual(["duplicate", "processed"]);

      const events = await db.select().from(notificationDeliveryEvents).where(eq(notificationDeliveryEvents.alertRecipientId, recipientId));
      expect(events).toHaveLength(1);
    });
  });

  describe("concurrent Incident lifecycle transitions", () => {
    const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
    const db: Database = getDb();
    const createdUserIds: string[] = [];
    const createdIncidentIds: string[] = [];

    afterAll(async () => {
      for (const id of createdIncidentIds) {
        await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
        await db.delete(incidentTimelineEvents).where(eq(incidentTimelineEvents.incidentId, id));
        await db.delete(incidents).where(eq(incidents.id, id));
      }
      for (const id of createdUserIds) {
        await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
        await db.delete(users).where(eq(users.id, id));
      }
      await app.close();
    });

    async function createAdmin(): Promise<{ id: string; token: string; csrf: string }> {
      const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, "ADMIN")).limit(1);
      const email = `test-c24-lifecycle-admin-${randomUUID()}@example.invalid`;
      const passwordHash = await hashPassword("Correct-Horse-Battery-C24", config);
      const [row] = await db.insert(users).values({ email, displayName: "C24 Lifecycle Admin", passwordHash }).returning({ id: users.id });
      createdUserIds.push(row!.id);
      await db.insert(userRoles).values({ userId: row!.id, roleId: adminRole!.id });
      const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "Correct-Horse-Battery-C24" } });
      return {
        id: row!.id,
        token: response.cookies.find((c) => c.name === config.sessionCookieName)!.value,
        csrf: response.cookies.find((c) => c.name === config.csrfCookieName)!.value,
      };
    }

    function authHeaders(actor: { token: string; csrf: string }) {
      return {
        cookies: { [config.sessionCookieName]: actor.token, [config.csrfCookieName]: actor.csrf },
        headers: { "x-csrf-token": actor.csrf },
      };
    }

    async function createResolvedIncident(admin: { token: string; csrf: string }): Promise<string> {
      const created = await app.inject({
        method: "POST",
        url: "/incidents",
        ...authHeaders(admin),
        payload: { title: `C24 Lifecycle Race ${randomUUID().slice(0, 6)}`, severity: "warning" },
      });
      const incidentId = created.json().incident.id as string;
      createdIncidentIds.push(incidentId);
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${incidentId}/resolve`, ...authHeaders(admin) });
      return incidentId;
    }

    it("two concurrent close attempts on the same RESOLVED Incident: exactly one succeeds", async () => {
      const admin = await createAdmin();
      const incidentId = await createResolvedIncident(admin);

      const [first, second] = await Promise.all([
        app.inject({ method: "POST", url: `/incidents/${incidentId}/close`, ...authHeaders(admin) }),
        app.inject({ method: "POST", url: `/incidents/${incidentId}/close`, ...authHeaders(admin) }),
      ]);
      const statusCodes = [first.statusCode, second.statusCode].sort();
      expect(statusCodes).toEqual([200, 409]);

      const [row] = await db.select({ status: incidents.status }).from(incidents).where(eq(incidents.id, incidentId));
      expect(row!.status).toBe("closed");

      const timeline = await db.select().from(incidentTimelineEvents).where(eq(incidentTimelineEvents.incidentId, incidentId));
      expect(timeline.filter((e) => e.eventType === "INCIDENT_CLOSED")).toHaveLength(1);
    });

    it("concurrent close vs reopen on the same RESOLVED Incident: exactly one wins, final state is valid (never both)", async () => {
      const admin = await createAdmin();
      const incidentId = await createResolvedIncident(admin);

      const [closeResult, reopenResult] = await Promise.all([
        app.inject({ method: "POST", url: `/incidents/${incidentId}/close`, ...authHeaders(admin) }),
        app.inject({ method: "POST", url: `/incidents/${incidentId}/reopen`, ...authHeaders(admin) }),
      ]);
      const statusCodes = [closeResult.statusCode, reopenResult.statusCode].sort();
      expect(statusCodes).toEqual([200, 409]);

      const [row] = await db.select({ status: incidents.status }).from(incidents).where(eq(incidents.id, incidentId));
      // Whichever transition committed first determines the final state — either is valid, but it
      // must be exactly one of them, never a corrupted third state.
      expect(["closed", "active"]).toContain(row!.status);
      if (closeResult.statusCode === 200) {
        expect(row!.status).toBe("closed");
      } else {
        expect(row!.status).toBe("active");
      }
    });
  });
});
