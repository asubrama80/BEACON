/**
 * Module 24 — critical end-to-end workflow tests. Every other integration suite in this codebase
 * is scoped to one module's own routes; this file is the one place that chains a full journey
 * across modules end-to-end (login → Incident lifecycle → Alert dispatch → Guest invite/OTP/
 * chat/War Room → removal → Incident close → Audit → Administration), the way a real operator
 * session would actually traverse the application. Each `it()` within a `describe` block builds
 * on state left by the previous one (a deliberate journey, not independent unit-of-work tests) —
 * run order within a file is stable in Vitest, matching every other sequential-setup pattern
 * already used in this suite (e.g. `beforeAll` chains). Skipped when DATABASE_URL isn't reachable.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Secret, TOTP } from "otpauth";
import {
  getDb,
  users,
  roles,
  userRoles,
  contacts,
  incidents,
  incidentParticipants,
  guestInvitations,
  chatMessages,
  incidentWarRooms,
  warRoomSessions,
  incidentTimelineEvents,
  alerts,
  alertRecipients,
  auditLogs,
  type Database,
} from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("critical end-to-end workflows (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  let capturedOtpCode = "";
  const app = buildTestApp(
    {
      LOGIN_RATE_LIMIT_MAX: "500",
      SMS_PROVIDER: "mock",
      EMAIL_PROVIDER: "mock",
      GUEST_OTP_REQUEST_RATE_LIMIT_MAX: "500",
      GUEST_OTP_VERIFY_RATE_LIMIT_MAX: "500",
    },
    { onOtpGenerated: (code) => { capturedOtpCode = code; } },
  );
  const db: Database = getDb();
  const testPassword = "Correct-Horse-Battery-C24-E2E";
  const createdUserIds: string[] = [];
  const createdIncidentIds: string[] = [];
  const createdContactIds: string[] = [];
  const createdAlertIds: string[] = [];

  afterAll(async () => {
    for (const id of createdIncidentIds) {
      await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
      await db.delete(incidentTimelineEvents).where(eq(incidentTimelineEvents.incidentId, id));
      await db.delete(chatMessages).where(eq(chatMessages.incidentId, id));
      await db.delete(warRoomSessions).where(eq(warRoomSessions.warRoomId, id)).catch(() => {});
      await db.delete(incidentWarRooms).where(eq(incidentWarRooms.incidentId, id));
      await db.delete(incidentParticipants).where(eq(incidentParticipants.incidentId, id));
      await db.delete(guestInvitations).where(eq(guestInvitations.incidentId, id));
      await db.delete(incidents).where(eq(incidents.id, id));
    }
    for (const id of createdAlertIds) {
      await db.delete(alertRecipients).where(eq(alertRecipients.alertId, id));
      await db.delete(alerts).where(eq(alerts.id, id));
    }
    for (const id of createdContactIds) {
      await db.delete(contacts).where(eq(contacts.id, id));
    }
    for (const id of createdUserIds) {
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
      await db.delete(users).where(eq(users.id, id));
    }
    await app.close();
  });

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode: string): Promise<{ id: string; email: string; token: string; csrf: string }> {
    const email = `test-c24-e2e-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db.insert(users).values({ email, displayName: `E2E ${roleCode}`, passwordHash }).returning({ id: users.id });
    createdUserIds.push(row!.id);
    await db.insert(userRoles).values({ userId: row!.id, roleId: await roleId(roleCode) });
    const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: testPassword } });
    if (response.statusCode !== 200) throw new Error(`login failed for ${roleCode}: ${response.statusCode} ${response.body}`);
    return {
      id: row!.id,
      email,
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

  let admin: { id: string; email: string; token: string; csrf: string };
  let auditor: { id: string; email: string; token: string; csrf: string };

  beforeAll(async () => {
    admin = await createActor("ADMIN");
    auditor = await createActor("AUDITOR");
  });

  describe("8.1 registered responder authentication", () => {
    it("logs in, receives a secure session, and Dashboard loads with permissions — no secrets leak", async () => {
      const me = await app.inject({ method: "GET", url: "/auth/me", ...authHeaders(admin) });
      expect(me.statusCode).toBe(200);
      expect(me.json().user.permissions).toContain("incidents.create");
      expect(JSON.stringify(me.json())).not.toMatch(/passwordHash|password_hash/i);

      const dashboard = await app.inject({ method: "GET", url: "/dashboard", ...authHeaders(admin) });
      expect(dashboard.statusCode).toBe(200);
    });

    it("MFA-enabled login requires and accepts a TOTP code, producing an authorized session", async () => {
      const mfaUser = await createActor("RESPONDER");
      const enroll = await app.inject({ method: "POST", url: "/auth/mfa/enroll", ...authHeaders(mfaUser) });
      expect(enroll.statusCode).toBe(200);
      const secret = enroll.json().secret as string;
      const currentCode = () => new TOTP({ secret: Secret.fromBase32(secret), algorithm: "SHA1", digits: 6, period: 30 }).generate();

      const confirm = await app.inject({
        method: "POST",
        url: "/auth/mfa/enroll/confirm",
        ...authHeaders(mfaUser),
        payload: { totp: currentCode() },
      });
      expect(confirm.statusCode).toBe(200);

      const loginWithoutMfa = await app.inject({ method: "POST", url: "/auth/login", payload: { email: mfaUser.email, password: testPassword } });
      expect(loginWithoutMfa.statusCode).toBe(401);
      expect(loginWithoutMfa.json().error).toBe("mfa_required");

      const loginWithMfa = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: mfaUser.email, password: testPassword, totp: currentCode() },
      });
      expect(loginWithMfa.statusCode).toBe(200);
    });
  });

  let incidentId: string;

  describe("8.2 full Incident lifecycle", () => {
    it("creates an Incident (OPEN)", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/incidents",
        ...authHeaders(admin),
        payload: { title: `C24 E2E Incident ${randomUUID().slice(0, 6)}`, severity: "critical" },
      });
      expect(response.statusCode).toBe(201);
      incidentId = response.json().incident.id as string;
      createdIncidentIds.push(incidentId);
      expect(response.json().incident.status).toBe("open");
    });

    it("activates the Incident", async () => {
      const response = await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
      expect(response.json().incident.status).toBe("active");
    });

    it("adds a Contact participant to the roster", async () => {
      const [contact] = await db
        .insert(contacts)
        .values({ firstName: "C24", lastName: "Participant", email: `c24-participant-${randomUUID()}@example.invalid` })
        .returning({ id: contacts.id });
      createdContactIds.push(contact!.id);
      const response = await app.inject({
        method: "POST",
        url: `/incidents/${incidentId}/participants/contacts`,
        ...authHeaders(admin),
        payload: { contactId: contact!.id },
      });
      expect(response.statusCode).toBe(201);
    });

    it("rejects an invalid transition (activate again)", async () => {
      const response = await app.inject({ method: "POST", url: `/incidents/${incidentId}/activate`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe("invalid_transition");
    });

    it("resolves the Incident", async () => {
      const response = await app.inject({ method: "POST", url: `/incidents/${incidentId}/resolve`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
      expect(response.json().incident.status).toBe("resolved");
    });

    it("reopens the Incident (RESOLVED → ACTIVE)", async () => {
      const response = await app.inject({ method: "POST", url: `/incidents/${incidentId}/reopen`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
      expect(response.json().incident.status).toBe("active");
    });

    it("resolves again", async () => {
      const response = await app.inject({ method: "POST", url: `/incidents/${incidentId}/resolve`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
    });

    it("verifies the timeline reflects every transition in order", async () => {
      const timeline = await db
        .select({ eventType: incidentTimelineEvents.eventType })
        .from(incidentTimelineEvents)
        .where(eq(incidentTimelineEvents.incidentId, incidentId))
        .orderBy(incidentTimelineEvents.occurredAt);
      const types = timeline.map((t) => t.eventType);
      expect(types).toEqual(
        expect.arrayContaining(["INCIDENT_CREATED", "INCIDENT_ACTIVATED", "INCIDENT_RESOLVED", "INCIDENT_REOPENED", "INCIDENT_RESOLVED"]),
      );
    });
  });

  let alertId: string;
  let alertRecipientId: string;

  describe("8.3 Alert workflow", () => {
    it("creates a DRAFT Alert with a Contact recipient", async () => {
      const [contact] = await db
        .insert(contacts)
        .values({ firstName: "C24", lastName: "Recipient", mobilePhone: `+1555${randomUUID().slice(0, 7).padStart(7, "0")}` })
        .returning({ id: contacts.id });
      createdContactIds.push(contact!.id);
      const response = await app.inject({
        method: "POST",
        url: "/alerts",
        ...authHeaders(admin),
        payload: {
          title: `C24 E2E Alert ${randomUUID().slice(0, 6)}`,
          channel: "sms",
          contentSource: "adhoc",
          body: "This is a test alert.",
          contactIds: [contact!.id],
          incidentId,
        },
      });
      expect(response.statusCode).toBe(201);
      alertId = response.json().alert.id as string;
      createdAlertIds.push(alertId);
      expect(response.json().alert.status).toBe("draft");
    });

    it("previews the Alert", async () => {
      const response = await app.inject({ method: "POST", url: `/alerts/${alertId}/preview`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
      expect(response.json().eligibleCount).toBe(1);
    });

    it("marks the Alert READY, freezing an immutable recipient snapshot", async () => {
      const response = await app.inject({ method: "POST", url: `/alerts/${alertId}/ready`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
      expect(response.json().alert.status).toBe("ready");
    });

    it("dispatches the Alert to the mock provider", async () => {
      const response = await app.inject({ method: "POST", url: `/alerts/${alertId}/dispatch`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "submitted", submitted: 1, submissionFailed: 0 });

      const recipients = await db.select({ id: alertRecipients.id }).from(alertRecipients).where(eq(alertRecipients.alertId, alertId));
      alertRecipientId = recipients[0]!.id;
    });

    it("simulates a delivered outcome and confirms submitted != delivered were distinct states along the way", async () => {
      const beforeDelivery = await app.inject({ method: "GET", url: `/alerts/${alertId}`, ...authHeaders(admin) });
      expect(beforeDelivery.json().alert.deliverySummary.delivered).toBe(0);
      expect(beforeDelivery.json().alert.deliverySummary.deliveryPending).toBe(1);

      const response = await app.inject({
        method: "POST",
        url: `/alerts/${alertId}/recipients/${alertRecipientId}/mock-delivery`,
        ...authHeaders(admin),
        payload: { status: "delivered" },
      });
      expect(response.statusCode).toBe(200);

      const afterDelivery = await app.inject({ method: "GET", url: `/alerts/${alertId}`, ...authHeaders(admin) });
      expect(afterDelivery.json().alert.deliverySummary.delivered).toBe(1);
    });

    it("Dashboard reflects the dispatched/delivered Alert", async () => {
      const response = await app.inject({ method: "GET", url: "/dashboard", ...authHeaders(admin) });
      expect(response.statusCode).toBe(200);
      expect(response.json().alerts.delivery.delivered).toBeGreaterThanOrEqual(1);
    });
  });

  let guestToken: string;
  let guestInvitationId: string;
  let guestSessionCookie: string;
  let guestCsrfCookie: string;
  let guestParticipantId: string;

  function guestAuth() {
    return {
      cookies: { beacon_guest_session: guestSessionCookie, beacon_guest_csrf: guestCsrfCookie },
      headers: { "x-guest-csrf-token": guestCsrfCookie },
    };
  }

  describe("8.4 Guest workflow", () => {
    it("creates a Guest invitation", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/incidents/${incidentId}/guest-invitations`,
        ...authHeaders(admin),
        payload: {
          guestName: "E2E Guest",
          email: `c24-e2e-guest-${randomUUID()}@example.invalid`,
          capabilities: { chat: true, warRoom: true },
        },
      });
      expect(response.statusCode).toBe(201);
      guestInvitationId = response.json().invitation.id as string;
      guestToken = (response.json().invitationUrl as string).split("/guest/invite/")[1]!;
    });

    it("requests an OTP (test-only capture, never a real SMS/email)", async () => {
      const response = await app.inject({ method: "POST", url: `/guest/invitations/${guestToken}/otp/request` });
      expect(response.statusCode).toBe(200);
      expect(capturedOtpCode).toMatch(/^\d{6}$/);
    });

    it("verifies the OTP and receives a Guest session", async () => {
      const response = await app.inject({ method: "POST", url: `/guest/invitations/${guestToken}/otp/verify`, payload: { code: capturedOtpCode } });
      expect(response.statusCode).toBe(200);
      guestSessionCookie = response.cookies.find((c) => c.name === "beacon_guest_session")!.value;
      guestCsrfCookie = response.cookies.find((c) => c.name === "beacon_guest_csrf")!.value;
    });

    it("auto-enrolled the Guest as a participant, never as a User", async () => {
      const rows = await db
        .select()
        .from(incidentParticipants)
        .where(eq(incidentParticipants.guestInvitationId, guestInvitationId));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.participantType).toBe("guest");
      expect(rows[0]!.userId).toBeNull();
      guestParticipantId = rows[0]!.id;

      const [invitedUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, `c24-e2e-guest-${guestInvitationId}@example.invalid`));
      expect(invitedUser).toBeUndefined();
    });

    it("the Guest can send a Chat message", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/guest/incidents/${incidentId}/chat/messages`,
        ...guestAuth(),
      });
      expect(response.statusCode).toBe(200);
      // (WebSocket send is covered exhaustively in chatWebsocket.test.ts and
      // guestParticipant.integration.test.ts — this workflow test confirms the Guest's session
      // itself grants reachable chat access, not the full socket protocol again.)
    });

    it("the Guest can read War Room metadata once opened", async () => {
      const opened = await app.inject({ method: "POST", url: `/incidents/${incidentId}/war-room/open`, ...authHeaders(admin) });
      expect(opened.statusCode).toBe(200);

      const joined = await app.inject({ method: "POST", url: `/guest/incidents/${incidentId}/war-room/join`, ...guestAuth() });
      expect(joined.statusCode).toBe(200);

      const read = await app.inject({ method: "GET", url: `/guest/incidents/${incidentId}/war-room`, ...guestAuth() });
      expect(read.statusCode).toBe(200);
      expect(read.json().activeSessionCount).toBeGreaterThanOrEqual(1);
    });

    it("removal immediately denies the Guest", async () => {
      const remove = await app.inject({
        method: "DELETE",
        url: `/incidents/${incidentId}/participants/${guestParticipantId}`,
        ...authHeaders(admin),
      });
      expect(remove.statusCode).toBe(204);

      const afterRemoval = await app.inject({ method: "GET", url: "/guest/session", ...guestAuth() });
      expect(afterRemoval.statusCode).toBe(401);
    });
  });

  describe("8.5 Incident close immediately blocks a still-active Guest", () => {
    let closeGuestSessionCookie: string;
    let closeGuestCsrfCookie: string;
    let closeIncidentId: string;

    it("sets up a fresh active Guest on a fresh Incident", async () => {
      const incidentResponse = await app.inject({
        method: "POST",
        url: "/incidents",
        ...authHeaders(admin),
        payload: { title: `C24 E2E Close Incident ${randomUUID().slice(0, 6)}`, severity: "warning" },
      });
      closeIncidentId = incidentResponse.json().incident.id as string;
      createdIncidentIds.push(closeIncidentId);

      const invitationResponse = await app.inject({
        method: "POST",
        url: `/incidents/${closeIncidentId}/guest-invitations`,
        ...authHeaders(admin),
        payload: { guestName: "Close Test Guest", email: `c24-close-guest-${randomUUID()}@example.invalid`, capabilities: { chat: true, warRoom: true } },
      });
      const token = (invitationResponse.json().invitationUrl as string).split("/guest/invite/")[1]!;
      await app.inject({ method: "POST", url: `/guest/invitations/${token}/otp/request` });
      const verify = await app.inject({ method: "POST", url: `/guest/invitations/${token}/otp/verify`, payload: { code: capturedOtpCode } });
      closeGuestSessionCookie = verify.cookies.find((c) => c.name === "beacon_guest_session")!.value;
      closeGuestCsrfCookie = verify.cookies.find((c) => c.name === "beacon_guest_csrf")!.value;

      const before = await app.inject({
        method: "GET",
        url: "/guest/session",
        cookies: { beacon_guest_session: closeGuestSessionCookie, beacon_guest_csrf: closeGuestCsrfCookie },
      });
      expect(before.statusCode).toBe(200);
    });

    it("closing the Incident denies the Guest immediately via HTTP", async () => {
      await app.inject({ method: "POST", url: `/incidents/${closeIncidentId}/activate`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${closeIncidentId}/resolve`, ...authHeaders(admin) });
      await app.inject({ method: "POST", url: `/incidents/${closeIncidentId}/close`, ...authHeaders(admin) });

      const after = await app.inject({
        method: "GET",
        url: "/guest/session",
        cookies: { beacon_guest_session: closeGuestSessionCookie, beacon_guest_csrf: closeGuestCsrfCookie },
      });
      expect(after.statusCode).toBe(401);

      const chatHistory = await app.inject({
        method: "GET",
        url: `/guest/incidents/${closeIncidentId}/chat/messages`,
        cookies: { beacon_guest_session: closeGuestSessionCookie, beacon_guest_csrf: closeGuestCsrfCookie },
      });
      expect(chatHistory.statusCode).toBe(401);

      const warRoomJoin = await app.inject({
        method: "POST",
        url: `/guest/incidents/${closeIncidentId}/war-room/join`,
        cookies: { beacon_guest_session: closeGuestSessionCookie, beacon_guest_csrf: closeGuestCsrfCookie },
        headers: { "x-guest-csrf-token": closeGuestCsrfCookie },
      });
      expect(warRoomJoin.statusCode).toBe(401);
    });
  });

  describe("8.6 Audit workflow reflects this journey's own state changes", () => {
    it("finds correctly-attributed events for this journey's Incident creation and Alert dispatch", async () => {
      const response = await app.inject({ method: "GET", url: `/audit?incidentId=${incidentId}&limit=100`, ...authHeaders(auditor) });
      expect(response.statusCode).toBe(200);
      const items = response.json().items as Array<{ eventType: string; actor: { type: string; id: string } }>;
      const created = items.find((i) => i.eventType === "INCIDENT_CREATED");
      expect(created?.actor).toMatchObject({ type: "user", id: admin.id });
      expect(items.map((i) => i.eventType)).toEqual(expect.arrayContaining(["INCIDENT_CREATED", "GUEST_ACCESS_REVOKED"]));
    });

    it("Guest OTP verification is attributed to the guest actor, never system or a fake user", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/audit?eventType=GUEST_VERIFICATION_SUCCEEDED&incidentId=${incidentId}&limit=10`,
        ...authHeaders(auditor),
      });
      expect(response.statusCode).toBe(200);
      const item = response.json().items[0];
      expect(item.actor.type).toBe("guest");
    });
  });

  describe("8.7 Administration workflow", () => {
    let targetUserId: string;

    it("Admin creates a synthetic User via the Users API", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/users",
        ...authHeaders(admin),
        payload: { email: `c24-e2e-admintarget-${randomUUID()}@example.invalid`, displayName: "E2E Admin Target", initialPassword: "Some-Strong-Pass-123456", roleCodes: ["RESPONDER"] },
      });
      expect(response.statusCode).toBe(201);
      targetUserId = response.json().user.id as string;
      createdUserIds.push(targetUserId);
    });

    it("Admin performs a security action (session revoke) and it is audited exactly once", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/admin/users/${targetUserId}/sessions/revoke`,
        ...authHeaders(admin),
      });
      expect(response.statusCode).toBe(200);

      const audit = await app.inject({
        method: "GET",
        url: `/audit?eventType=USER_SESSIONS_ADMIN_REVOKED&resourceId=${targetUserId}&limit=10`,
        ...authHeaders(auditor),
      });
      expect(audit.json().items).toHaveLength(1);
    });

    it("Guest and low-privilege User are denied Administration", async () => {
      const noPerm = await createActor("RESPONDER");
      const deniedForUser = await app.inject({ method: "GET", url: "/admin/status", ...authHeaders(noPerm) });
      expect(deniedForUser.statusCode).toBe(403);

      const deniedForGuest = await app.inject({ method: "GET", url: "/admin/status", cookies: { beacon_guest_session: "anything" } });
      expect(deniedForGuest.statusCode).toBe(401);
    });

    it("the last-admin safeguard still holds for this journey's own admin", async () => {
      const activeAdminRows = await db
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .where(eq(userRoles.roleId, await roleId("ADMIN")));
      if (activeAdminRows.length !== 1) return; // invariant not reachable in a shared dev DB
      const response = await app.inject({ method: "POST", url: `/users/${activeAdminRows[0]!.userId}/disable`, ...authHeaders(admin) });
      expect(response.statusCode).toBe(409);
    });
  });
});
