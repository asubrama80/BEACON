/**
 * Live-database tests for effective-permission computation. Skipped when DATABASE_URL isn't
 * available, same convention as the Module 02 integration suite.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, users, roles, userRoles, auditLogs, type Database } from "@beacon/database";
import { getEffectivePermissions, hasPermission, getUserRoles } from "../../modules/rbac/permissions.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

describe.skipIf(!process.env.DATABASE_URL)("effective permissions (live database)", () => {
  const db: Database = getDb();
  let userId: string;
  const createdUserIds: string[] = [];

  async function createTestUser(): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `test-rbac-${randomUUID()}@example.invalid`,
        displayName: "RBAC Test User",
        passwordHash: "unused-in-this-test",
      })
      .returning({ id: users.id });
    createdUserIds.push(row!.id);
    return row!.id;
  }

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  beforeAll(async () => {
    userId = await createTestUser();
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await db.delete(users).where(eq(users.id, id));
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
    }
  });

  it("returns no permissions for a user with no roles", async () => {
    const perms = await getEffectivePermissions(db, userId);
    expect(perms.size).toBe(0);
  });

  it("returns AUDITOR's read-only permission set", async () => {
    await db.insert(userRoles).values({ userId, roleId: await roleId("AUDITOR") });

    const perms = await getEffectivePermissions(db, userId);
    expect([...perms].sort()).toEqual([
      "alerts.delivery.read",
      "alerts.read",
      "alerts.recipients.read",
      "contacts.read",
      "groups.read",
      "incidents.chat.read",
      "incidents.command_center.read",
      "incidents.read",
      "incidents.timeline.read",
      "permissions.read",
      "roles.read",
      "templates.read",
      "users.read",
    ]);

    await db.delete(userRoles).where(eq(userRoles.userId, userId));
  });

  it("unions permissions across multiple assigned roles with no duplicates", async () => {
    await db.insert(userRoles).values([
      { userId, roleId: await roleId("AUDITOR") },
      { userId, roleId: await roleId("RESPONDER") },
    ]);

    const perms = await getEffectivePermissions(db, userId);
    // AUDITOR grants 13 permissions (Modules 03/04/06/07/08/09/11/12/13); RESPONDER's 6
    // permissions are almost a subset of AUDITOR's, except RESPONDER also gets
    // incidents.chat.send (send access AUDITOR deliberately lacks, being read-only) — so the
    // union is AUDITOR's 13 plus that one extra, 14 total. Never a duplicate (Set already
    // guarantees this, but assert the count matches too).
    expect(perms.size).toBe(14);
    expect([...perms].sort()).toEqual([
      "alerts.delivery.read",
      "alerts.read",
      "alerts.recipients.read",
      "contacts.read",
      "groups.read",
      "incidents.chat.read",
      "incidents.chat.send",
      "incidents.command_center.read",
      "incidents.read",
      "incidents.timeline.read",
      "permissions.read",
      "roles.read",
      "templates.read",
      "users.read",
    ]);

    await db.delete(userRoles).where(eq(userRoles.userId, userId));
  });

  it("ADMIN receives every current permission", async () => {
    await db.insert(userRoles).values({ userId, roleId: await roleId("ADMIN") });

    const perms = await getEffectivePermissions(db, userId);
    expect([...perms].sort()).toEqual(
      [
        "alerts.cancel",
        "alerts.create",
        "alerts.delivery.read",
        "alerts.dispatch",
        "alerts.read",
        "alerts.ready",
        "alerts.recipients.read",
        "alerts.update",
        "contacts.create",
        "contacts.disable",
        "contacts.import",
        "contacts.read",
        "contacts.update",
        "groups.create",
        "groups.disable",
        "groups.members.manage",
        "groups.read",
        "groups.update",
        "incidents.chat.read",
        "incidents.chat.send",
        "incidents.command_center.read",
        "incidents.commander.assign",
        "incidents.create",
        "incidents.lifecycle.manage",
        "incidents.participants.manage",
        "incidents.read",
        "incidents.timeline.read",
        "incidents.update",
        "permissions.read",
        "roles.read",
        "templates.create",
        "templates.disable",
        "templates.read",
        "templates.update",
        "users.create",
        "users.disable",
        "users.read",
        "users.roles.assign",
        "users.update",
      ].sort(),
    );

    await db.delete(userRoles).where(eq(userRoles.userId, userId));
  });

  it("hasPermission reflects the effective set", async () => {
    await db.insert(userRoles).values({ userId, roleId: await roleId("AUDITOR") });

    expect(await hasPermission(db, userId, "users.read")).toBe(true);
    expect(await hasPermission(db, userId, "users.create")).toBe(false);

    await db.delete(userRoles).where(eq(userRoles.userId, userId));
  });

  it("getUserRoles returns the assigned role codes", async () => {
    await db.insert(userRoles).values({ userId, roleId: await roleId("RESPONDER") });

    const assigned = await getUserRoles(db, userId);
    expect(assigned.map((r) => r.code)).toEqual(["RESPONDER"]);

    await db.delete(userRoles).where(eq(userRoles.userId, userId));
  });
});
