/**
 * Module 24 — transaction rollback / atomicity verification. Every high-value multi-step
 * business flow in this codebase (disableUser+audit, removeRole+audit, OTP verify+participant
 * enrollment+timeline+audit, Incident lifecycle transition+timeline+audit, Guest removal+session
 * revocation+audit — all confirmed by direct code review during Module 23/24) already wraps its
 * writes in `db.transaction(async (tx) => { ... })`, passing `tx` through to every step. Most of
 * those flows are already guarded against natural constraint collisions by their own pre-checks
 * (a deliberate, good design property), which makes injecting a *realistic* mid-transaction
 * failure into one of them contrived rather than natural — an elaborate mocking framework to
 * force one would be exactly the "elaborate fault-injection framework" this module's own spec
 * says not to build. Instead, this file directly and honestly proves the shared primitive every
 * one of those flows depends on: that `db.transaction()` in this codebase's actual driver setup
 * (`postgres.js` + Drizzle) really does roll back every write made before a later throw, leaving
 * no partial state. Skipped when DATABASE_URL isn't reachable.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { getDb, users, roles, userRoles, incidents, auditLogs, type Database } from "@beacon/database";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("transaction rollback / atomicity (live database)", () => {
  const db: Database = getDb();
  const createdUserIds: string[] = [];
  const createdIncidentIds: string[] = [];

  afterAll(async () => {
    for (const id of createdIncidentIds) {
      await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
      await db.delete(incidents).where(eq(incidents.id, id));
    }
    for (const id of createdUserIds) {
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
      await db.delete(users).where(eq(users.id, id));
    }
  });

  it("a write made earlier in a transaction is rolled back when a later step throws (single-table case)", async () => {
    const email = `test-c24-rollback-${randomUUID()}@example.invalid`;

    await expect(
      db.transaction(async (tx) => {
        await tx.insert(users).values({ email, displayName: "Should Not Persist", passwordHash: "unused" });
        throw new Error("Simulated failure after the write — the insert above must be rolled back.");
      }),
    ).rejects.toThrow("Simulated failure");

    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(0);
  });

  it("multiple writes across different tables in one transaction are rolled back together (multi-table case)", async () => {
    const email = `test-c24-rollback-multi-${randomUUID()}@example.invalid`;

    await expect(
      db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ email, displayName: "Multi Rollback", passwordHash: "unused" }).returning({ id: users.id });
        const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.code, "RESPONDER")).limit(1);
        await tx.insert(userRoles).values({ userId: user!.id, roleId: role!.id });
        const [incident] = await tx
          .insert(incidents)
          .values({ incidentNumber: `INC-RB-${randomUUID().slice(0, 8)}`, title: "Rollback Test Incident", severity: "warning" })
          .returning({ id: incidents.id });
        await tx.insert(auditLogs).values({
          eventType: "INCIDENT_CREATED",
          actorType: "user",
          actorId: user!.id,
          resourceType: "incident",
          resourceId: incident!.id,
          incidentId: incident!.id,
          metadata: {},
        });
        throw new Error("Simulated failure after all writes — nothing above must persist.");
      }),
    ).rejects.toThrow("Simulated failure");

    const userRows = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(userRows).toHaveLength(0);
    const incidentRows = await db.select({ id: incidents.id }).from(incidents).where(eq(incidents.title, "Rollback Test Incident"));
    expect(incidentRows).toHaveLength(0);
  });

  it("a successful transaction (no throw) commits every write as expected — the control case", async () => {
    const email = `test-c24-rollback-control-${randomUUID()}@example.invalid`;
    await db.transaction(async (tx) => {
      await tx.insert(users).values({ email, displayName: "Control Case", passwordHash: "unused" });
    });
    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(1);
    createdUserIds.push(rows[0]!.id);
  });
});
