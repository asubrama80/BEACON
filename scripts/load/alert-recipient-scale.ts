/**
 * Module 24 — moderate-scale Alert recipient resolution test. Establishes an observed local
 * baseline, not a production capacity guarantee. Uses only synthetic Contacts and the mock
 * provider — never sends anything externally. Never runs as part of the normal test suite.
 *
 *   npx tsx scripts/load/alert-recipient-scale.ts
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { getDb, users, roles, userRoles, contacts, alerts, alertRecipients, closeDb } from "@beacon/database";
import { buildApp } from "../../backend/src/app.js";
import { loadEnv } from "../../backend/src/config/env.js";

loadDotenv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });

// 500 is the actual system-enforced ceiling on `contactIds` per Alert-creation request (schema
// validation) — discovered by this harness itself hitting `400 body/contactIds must NOT have
// more than 500 items` at the 1000 tier. That's a deliberate safety bound (Module 09's
// server-side max-recipient limit), not a bug, so the top tier is capped at the real maximum
// rather than working around it.
const TIERS = [100, 500];

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — cannot run the load harness against a real database.");
    process.exit(1);
  }

  const env = loadEnv();
  const app = buildApp({ env });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("failed to determine listening port");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const db = getDb();
  const { hashPassword } = await import("../../backend/src/modules/auth/password.js");
  const { loadAuthConfig } = await import("../../backend/src/modules/auth/config.js");
  const authConfig = loadAuthConfig();

  const allCreatedContactIds: string[] = [];
  const allCreatedAlertIds: string[] = [];
  let adminUserId: string | undefined;

  try {
  const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, "ADMIN")).limit(1);
  const email = `test-c24-alertscale-admin-${randomUUID()}@example.invalid`;
  const passwordHash = await hashPassword("Correct-Horse-Battery-C24-AlertScale", authConfig);
  const [adminUser] = await db.insert(users).values({ email, displayName: "Alert Scale Admin", passwordHash }).returning({ id: users.id });
  adminUserId = adminUser!.id;
  await db.insert(userRoles).values({ userId: adminUser!.id, roleId: adminRole!.id });

  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Correct-Horse-Battery-C24-AlertScale" }),
  });
  const setCookieHeaders = loginRes.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookieHeaders.map((c) => c.split(";")[0]).join("; ");
  const csrfCookie = setCookieHeaders.find((c) => c.startsWith(`${authConfig.csrfCookieName}=`));
  const csrfToken = csrfCookie ? csrfCookie.split(";")[0]!.split("=")[1]! : "";

  console.log("Alert recipient scale harness\n");

  for (const size of TIERS) {
    const suffix = randomUUID().slice(0, 8);
    const rows = Array.from({ length: size }, (_, i) => ({
      firstName: `Scale${size}`,
      lastName: `Contact${i}`,
      mobilePhone: `+1555${String(i).padStart(7, "0")}`,
    }));
    const insertStart = performance.now();
    const inserted: { id: string }[] = [];
    // Batch in chunks of 500 to stay well within a single statement's practical parameter limits.
    for (let offset = 0; offset < rows.length; offset += 500) {
      const chunk = rows.slice(offset, offset + 500).map((r) => ({ ...r, mobilePhone: `${r.mobilePhone}${suffix.slice(0, 2)}` }));
      const result = await db.insert(contacts).values(chunk).returning({ id: contacts.id });
      inserted.push(...result);
    }
    allCreatedContactIds.push(...inserted.map((r) => r.id));
    const insertMs = performance.now() - insertStart;

    const createStart = performance.now();
    const createResponse = await fetch(`${baseUrl}/alerts`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookie, "x-csrf-token": csrfToken },
      body: JSON.stringify({
        title: `Scale Test Alert ${size}`,
        channel: "sms",
        contentSource: "adhoc",
        body: "Scale test",
        contactIds: inserted.map((r) => r.id),
      }),
    });
    if (!createResponse.ok) throw new Error(`Alert creation failed at size ${size}: ${createResponse.status} ${await createResponse.text()}`);
    const alertBody = (await createResponse.json()) as { alert: { id: string } };
    allCreatedAlertIds.push(alertBody.alert.id);
    const createMs = performance.now() - createStart;

    const previewStart = performance.now();
    const previewResponse = await fetch(`${baseUrl}/alerts/${alertBody.alert.id}/preview`, {
      method: "POST",
      headers: { cookie: sessionCookie, "x-csrf-token": csrfToken },
    });
    const previewBody = (await previewResponse.json()) as { eligibleCount: number };
    const previewMs = performance.now() - previewStart;

    const readyStart = performance.now();
    const readyResponse = await fetch(`${baseUrl}/alerts/${alertBody.alert.id}/ready`, {
      method: "POST",
      headers: { cookie: sessionCookie, "x-csrf-token": csrfToken },
    });
    const readyMs = performance.now() - readyStart;

    const recipientRows = await db.select({ id: alertRecipients.id }).from(alertRecipients).where(eq(alertRecipients.alertId, alertBody.alert.id));

    console.log(`  size=${size}: insertContacts=${insertMs.toFixed(0)}ms createAlert=${createMs.toFixed(0)}ms preview=${previewMs.toFixed(0)}ms ready=${readyMs.toFixed(0)}ms`);
    console.log(`    eligibleCount=${previewBody.eligibleCount} readyStatus=${readyResponse.status} recipientRows=${recipientRows.length} (expected ${size})`);
    if (previewBody.eligibleCount !== size || recipientRows.length !== size) {
      console.log("    MISMATCH — investigate.");
    }
  }

  } finally {
    // Always cleans up, even on error — see claude/prompts/24-testing.md, "Load harness cleanup".
    console.log("\nCleaning up...");
    for (const id of allCreatedAlertIds) {
      await db.delete(alertRecipients).where(eq(alertRecipients.alertId, id));
      await db.delete(alerts).where(eq(alerts.id, id));
    }
    for (let offset = 0; offset < allCreatedContactIds.length; offset += 500) {
      const chunk = allCreatedContactIds.slice(offset, offset + 500);
      for (const id of chunk) {
        await db.delete(contacts).where(eq(contacts.id, id));
      }
    }
    if (adminUserId) {
      await db.delete(users).where(eq(users.id, adminUserId));
    }
    await app.close();
    await closeDb();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
