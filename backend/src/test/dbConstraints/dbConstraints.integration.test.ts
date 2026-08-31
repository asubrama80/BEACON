/**
 * Module 24 — direct database-level constraint testing. Every test here bypasses service-layer
 * validation entirely and attempts a raw `db.insert(...)` that should violate a schema-level
 * unique index or check constraint, proving the DB itself is the real safety net (not merely a
 * service-layer pre-check that a bug could route around). Skipped when DATABASE_URL isn't
 * reachable.
 */
import { randomUUID } from "node:crypto";
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
  contacts,
  groups,
  groupMembers,
  incidents,
  incidentParticipants,
  incidentWarRooms,
  warRoomSessions,
  guestInvitations,
  guestOtpChallenges,
  notificationDeliveryEvents,
  alerts,
  alertRecipients,
  type Database,
} from "@beacon/database";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("database constraints (live database, direct insertion)", () => {
  const db: Database = getDb();
  const createdUserIds: string[] = [];
  const createdContactIds: string[] = [];
  const createdGroupIds: string[] = [];
  const createdIncidentIds: string[] = [];
  const createdAlertIds: string[] = [];

  afterAll(async () => {
    for (const id of createdIncidentIds) {
      await db.delete(warRoomSessions).where(eq(warRoomSessions.warRoomId, id)).catch(() => {});
      await db.delete(incidentWarRooms).where(eq(incidentWarRooms.incidentId, id));
      await db.delete(incidentParticipants).where(eq(incidentParticipants.incidentId, id));
      await db.delete(guestOtpChallenges).where(eq(guestOtpChallenges.invitationId, id)).catch(() => {});
      await db.delete(guestInvitations).where(eq(guestInvitations.incidentId, id));
      await db.delete(incidents).where(eq(incidents.id, id));
    }
    for (const id of createdAlertIds) {
      await db.delete(notificationDeliveryEvents).where(eq(notificationDeliveryEvents.alertId, id));
      await db.delete(alertRecipients).where(eq(alertRecipients.alertId, id));
      await db.delete(alerts).where(eq(alerts.id, id));
    }
    for (const id of createdGroupIds) {
      await db.delete(groupMembers).where(eq(groupMembers.groupId, id));
      await db.delete(groups).where(eq(groups.id, id));
    }
    for (const id of createdContactIds) {
      await db.delete(contacts).where(eq(contacts.id, id));
    }
    for (const id of createdUserIds) {
      await db.delete(userRoles).where(eq(userRoles.userId, id));
      await db.delete(users).where(eq(users.id, id));
    }
  });

  async function createUser(): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({ email: `test-dbc-${randomUUID()}@example.invalid`, displayName: "DB Constraint Test User", passwordHash: "unused" })
      .returning({ id: users.id });
    createdUserIds.push(row!.id);
    return row!.id;
  }

  async function createContact(): Promise<string> {
    const [row] = await db
      .insert(contacts)
      .values({ firstName: "DBC", lastName: "Test", email: `dbc-contact-${randomUUID()}@example.invalid` })
      .returning({ id: contacts.id });
    createdContactIds.push(row!.id);
    return row!.id;
  }

  async function createIncident(): Promise<string> {
    const [row] = await db
      .insert(incidents)
      .values({ incidentNumber: `INC-DBC-${randomUUID().slice(0, 8)}`, title: "DB Constraint Test Incident", severity: "warning" })
      .returning({ id: incidents.id });
    createdIncidentIds.push(row!.id);
    return row!.id;
  }

  // Drizzle wraps the raw `postgres` driver error inside a `DrizzleQueryError`, whose `.cause`
  // carries the actual `PostgresError` (with the standard Postgres error `code`) — the outer
  // wrapper itself has no `code` property.
  async function expectPostgresErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
    await expect(promise).rejects.toMatchObject({ cause: { code } });
  }

  async function expectUniqueViolation(promise: Promise<unknown>): Promise<void> {
    await expectPostgresErrorCode(promise, "23505");
  }

  async function expectCheckViolation(promise: Promise<unknown>): Promise<void> {
    await expectPostgresErrorCode(promise, "23514");
  }

  it("users: email uniqueness is enforced at the DB layer", async () => {
    const email = `test-dbc-dup-${randomUUID()}@example.invalid`;
    const [row] = await db.insert(users).values({ email, displayName: "First", passwordHash: "unused" }).returning({ id: users.id });
    createdUserIds.push(row!.id);
    await expectUniqueViolation(db.insert(users).values({ email, displayName: "Second", passwordHash: "unused" }));
  });

  it("users: at most one break-glass account can exist", async () => {
    const [first] = await db
      .insert(users)
      .values({ email: `test-dbc-bg1-${randomUUID()}@example.invalid`, displayName: "BG1", passwordHash: "unused", isBreakGlass: true })
      .returning({ id: users.id });
    createdUserIds.push(first!.id);
    try {
      await expectUniqueViolation(
        db.insert(users).values({ email: `test-dbc-bg2-${randomUUID()}@example.invalid`, displayName: "BG2", passwordHash: "unused", isBreakGlass: true }),
      );
    } finally {
      await db.update(users).set({ isBreakGlass: false }).where(eq(users.id, first!.id));
    }
  });

  it("user_roles: the same role cannot be assigned to the same User twice", async () => {
    const userId = await createUser();
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, "RESPONDER")).limit(1);
    await db.insert(userRoles).values({ userId, roleId: role!.id });
    await expectUniqueViolation(db.insert(userRoles).values({ userId, roleId: role!.id }));
  });

  it("group_members: the same Contact cannot be added to the same Group twice", async () => {
    const contactId = await createContact();
    const [group] = await db.insert(groups).values({ name: `DBC Group ${randomUUID().slice(0, 8)}` }).returning({ id: groups.id });
    createdGroupIds.push(group!.id);
    await db.insert(groupMembers).values({ groupId: group!.id, contactId });
    await expectUniqueViolation(db.insert(groupMembers).values({ groupId: group!.id, contactId }));
  });

  it("guest_invitations: at most one active invitation per destination per Incident", async () => {
    const incidentId = await createIncident();
    const email = `dbc-guest-${randomUUID()}@example.invalid`;
    await db.insert(guestInvitations).values({
      incidentId,
      guestName: "First",
      email,
      tokenHash: `hash-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 3600_000),
    });
    await expectUniqueViolation(
      db.insert(guestInvitations).values({
        incidentId,
        guestName: "Second",
        email,
        tokenHash: `hash-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    );
  });

  it("guest_invitations: at least one contact method (email or mobile) is required", async () => {
    const incidentId = await createIncident();
    await expectCheckViolation(
      db.insert(guestInvitations).values({
        incidentId,
        guestName: "No Destination",
        tokenHash: `hash-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3600_000),
      }),
    );
  });

  it("guest_otp_challenges: at most one active challenge per invitation", async () => {
    const incidentId = await createIncident();
    const [invitation] = await db
      .insert(guestInvitations)
      .values({
        incidentId,
        guestName: "OTP Test",
        email: `dbc-otp-${randomUUID()}@example.invalid`,
        tokenHash: `hash-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning({ id: guestInvitations.id });
    await db.insert(guestOtpChallenges).values({
      invitationId: invitation!.id,
      codeSalt: "salt",
      codeHash: "hash",
      expiresAt: new Date(Date.now() + 600_000),
    });
    await expectUniqueViolation(
      db.insert(guestOtpChallenges).values({
        invitationId: invitation!.id,
        codeSalt: "salt2",
        codeHash: "hash2",
        expiresAt: new Date(Date.now() + 600_000),
      }),
    );
  });

  describe("incident_participants: exactly-one-identity invariants", () => {
    it("a User cannot have two non-removed participant rows on the same Incident", async () => {
      const incidentId = await createIncident();
      const userId = await createUser();
      await db.insert(incidentParticipants).values({ incidentId, participantType: "user", userId, status: "joined" });
      await expectUniqueViolation(
        db.insert(incidentParticipants).values({ incidentId, participantType: "user", userId, status: "invited" }),
      );
    });

    it("a Contact cannot have two non-removed participant rows on the same Incident", async () => {
      const incidentId = await createIncident();
      const contactId = await createContact();
      await db.insert(incidentParticipants).values({ incidentId, participantType: "contact", contactId, status: "joined" });
      await expectUniqueViolation(
        db.insert(incidentParticipants).values({ incidentId, participantType: "contact", contactId, status: "invited" }),
      );
    });

    it("removing then re-adding the same User is allowed (removed rows fall outside the active index)", async () => {
      const incidentId = await createIncident();
      const userId = await createUser();
      await db.insert(incidentParticipants).values({ incidentId, participantType: "user", userId, status: "removed" });
      await expect(
        db.insert(incidentParticipants).values({ incidentId, participantType: "user", userId, status: "joined" }),
      ).resolves.toBeDefined();
    });

    it("rejects a row whose participant_type doesn't match its set identity column (reference check)", async () => {
      const incidentId = await createIncident();
      const userId = await createUser();
      // participant_type says "guest" but a user_id is set instead of guest_invitation_id.
      await expectCheckViolation(
        db.insert(incidentParticipants).values({ incidentId, participantType: "guest", userId, status: "joined" }),
      );
    });

    it("rejects a row with no identity column set at all", async () => {
      const incidentId = await createIncident();
      await expectCheckViolation(db.insert(incidentParticipants).values({ incidentId, participantType: "user", status: "joined" }));
    });
  });

  describe("war_room_sessions: identity and single-active-session invariants", () => {
    async function openWarRoom(incidentId: string): Promise<string> {
      const [room] = await db.insert(incidentWarRooms).values({ incidentId }).returning({ id: incidentWarRooms.id });
      return room!.id;
    }

    it("at most one OPEN War Room per Incident", async () => {
      const incidentId = await createIncident();
      await openWarRoom(incidentId);
      await expectUniqueViolation(db.insert(incidentWarRooms).values({ incidentId }));
    });

    it("a User cannot have two active (joined) sessions in the same War Room", async () => {
      const incidentId = await createIncident();
      const warRoomId = await openWarRoom(incidentId);
      const userId = await createUser();
      await db.insert(warRoomSessions).values({ warRoomId, participantType: "user", userId, status: "joined" });
      await expectUniqueViolation(db.insert(warRoomSessions).values({ warRoomId, participantType: "user", userId, status: "joined" }));
    });

    it("rejects a row whose participant_type doesn't match its set identity column", async () => {
      const incidentId = await createIncident();
      const warRoomId = await openWarRoom(incidentId);
      const userId = await createUser();
      await expectCheckViolation(
        db.insert(warRoomSessions).values({ warRoomId, participantType: "guest", userId, status: "joined" }),
      );
    });
  });

  it("alert_recipients: the same Contact cannot appear twice on the same Alert", async () => {
    const [alert] = await db
      .insert(alerts)
      .values({
        alertNumber: `ALT-DBC-${randomUUID().slice(0, 8)}`,
        title: "DB Constraint Test Alert",
        channel: "sms",
        contentSource: "adhoc",
        body: "Hi",
        status: "draft",
        eligibleRecipientCount: 0,
        excludedCount: 0,
      })
      .returning({ id: alerts.id });
    createdAlertIds.push(alert!.id);
    const contactId = await createContact();

    await db.insert(alertRecipients).values({
      alertId: alert!.id,
      contactId,
      recipientName: "DBC Recipient",
      recipientAddress: "+15550001111",
      renderedBody: "Hi",
      channel: "sms",
      status: "pending_delivery",
    });
    await expectUniqueViolation(
      db.insert(alertRecipients).values({
        alertId: alert!.id,
        contactId,
        recipientName: "DBC Recipient Dup",
        recipientAddress: "+15550001111",
        renderedBody: "Hi",
        channel: "sms",
        status: "pending_delivery",
      }),
    );
  });

  it("notification_delivery_events: the dedupe key is globally unique (the real idempotency guarantee)", async () => {
    const [alert] = await db
      .insert(alerts)
      .values({
        alertNumber: `ALT-DBC-DEDUPE-${randomUUID().slice(0, 8)}`,
        title: "DB Constraint Test Alert",
        channel: "sms",
        contentSource: "adhoc",
        body: "Hi",
        status: "ready",
        eligibleRecipientCount: 1,
        excludedCount: 0,
      })
      .returning({ id: alerts.id });
    createdAlertIds.push(alert!.id);
    const [recipient] = await db
      .insert(alertRecipients)
      .values({
        alertId: alert!.id,
        recipientName: "DBC Recipient",
        recipientAddress: "+15550002222",
        renderedBody: "Hi",
        channel: "sms",
        status: "submitted",
        provider: "twilio",
        providerMessageId: "SMdbctest",
      })
      .returning({ id: alertRecipients.id });

    const dedupeKey = `twilio:msg:SMdbctest:delivered`;
    await db.insert(notificationDeliveryEvents).values({
      alertId: alert!.id,
      alertRecipientId: recipient!.id,
      provider: "twilio",
      providerMessageId: "SMdbctest",
      dedupeKey,
      rawProviderStatus: "delivered",
      normalizedStatus: "delivered",
      occurredAt: new Date(),
    });
    await expectUniqueViolation(
      db.insert(notificationDeliveryEvents).values({
        alertId: alert!.id,
        alertRecipientId: recipient!.id,
        provider: "twilio",
        providerMessageId: "SMdbctest",
        dedupeKey,
        rawProviderStatus: "delivered",
        normalizedStatus: "delivered",
        occurredAt: new Date(),
      }),
    );
  });
});
