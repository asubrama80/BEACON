/**
 * Module 24 — moderate-scale Contact CSV import test (upload → preview → confirm). Establishes
 * an observed local baseline, not a production capacity guarantee. Uses only synthetic, generated
 * rows — never real PII — and cleans up every imported Contact and temp batch row afterward.
 * Never runs as part of the normal test suite.
 *
 *   npx tsx scripts/load/import-scale.ts
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq, like } from "drizzle-orm";
import { getDb, users, roles, userRoles, contacts, contactImportBatches, contactImportRows, closeDb } from "@beacon/database";
import { buildApp } from "../../backend/src/app.js";
import { loadEnv } from "../../backend/src/config/env.js";

loadDotenv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });

// 2000 is the actual system-enforced ceiling on import file row count (Module 05's deliberate
// safety bound), discovered by this harness itself hitting `400 import_file_invalid: too many
// rows (max 2000)` at the 5000 tier — a real limit, not a bug, so the top tier is capped there.
const TIERS = [1000, 2000];

function generateCsv(size: number, refPrefix: string): string {
  const lines = ["First Name,Last Name,Email,Reference"];
  for (let i = 0; i < size; i += 1) {
    lines.push(`Import${size},Row${i},import-scale-${size}-${i}-${randomUUID().slice(0, 6)}@example.invalid,${refPrefix}-${i}`);
  }
  return lines.join("\n");
}

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

  let adminUserId: string | undefined;
  const refPrefix = `C24IMPORT-${randomUUID().slice(0, 8)}`;

  try {
  const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, "ADMIN")).limit(1);
  const email = `test-c24-importscale-admin-${randomUUID()}@example.invalid`;
  const passwordHash = await hashPassword("Correct-Horse-Battery-C24-ImportScale", authConfig);
  const [adminUser] = await db.insert(users).values({ email, displayName: "Import Scale Admin", passwordHash }).returning({ id: users.id });
  adminUserId = adminUser!.id;
  await db.insert(userRoles).values({ userId: adminUser!.id, roleId: adminRole!.id });

  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Correct-Horse-Battery-C24-ImportScale" }),
  });
  const setCookieHeaders = loginRes.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookieHeaders.map((c) => c.split(";")[0]).join("; ");
  const csrfCookie = setCookieHeaders.find((c) => c.startsWith(`${authConfig.csrfCookieName}=`));
  const csrfToken = csrfCookie ? csrfCookie.split(";")[0]!.split("=")[1]! : "";

  console.log("Contact import scale harness\n");

  for (const size of TIERS) {
    const csv = generateCsv(size, `${refPrefix}-${size}`);
    const form = new FormData();
    form.set("file", new Blob([csv], { type: "text/csv" }), `scale-${size}.csv`);

    const uploadStart = performance.now();
    const uploadResponse = await fetch(`${baseUrl}/contacts/import/upload`, {
      method: "POST",
      headers: { cookie: sessionCookie, "x-csrf-token": csrfToken },
      body: form,
    });
    if (!uploadResponse.ok) throw new Error(`Upload failed at size ${size}: ${uploadResponse.status} ${await uploadResponse.text()}`);
    const uploadBody = (await uploadResponse.json()) as { batch: { id: string } };
    const batchId = uploadBody.batch.id;
    const uploadMs = performance.now() - uploadStart;

    const previewStart = performance.now();
    const previewResponse = await fetch(`${baseUrl}/contacts/import/${batchId}/preview`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookie, "x-csrf-token": csrfToken },
      body: JSON.stringify({ mapping: { "First Name": "firstName", "Last Name": "lastName", Email: "email", Reference: "referenceId" } }),
    });
    if (!previewResponse.ok) throw new Error(`Preview failed at size ${size}: ${previewResponse.status} ${await previewResponse.text()}`);
    const previewBody = (await previewResponse.json()) as { rows: { id: string; status: string }[]; batch: { summary: { total: number; valid: number } } };
    const previewMs = performance.now() - previewStart;

    const decisions = previewBody.rows.filter((r) => r.status === "valid").map((r) => ({ rowId: r.id, selected: true }));

    const confirmStart = performance.now();
    const confirmResponse = await fetch(`${baseUrl}/contacts/import/${batchId}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookie, "x-csrf-token": csrfToken },
      body: JSON.stringify({ decisions }),
    });
    if (!confirmResponse.ok) throw new Error(`Confirm failed at size ${size}: ${confirmResponse.status} ${await confirmResponse.text()}`);
    const confirmBody = (await confirmResponse.json()) as { summary: { imported: number; skipped: number } };
    const confirmMs = performance.now() - confirmStart;

    console.log(`  size=${size}: upload=${uploadMs.toFixed(0)}ms preview=${previewMs.toFixed(0)}ms confirm=${confirmMs.toFixed(0)}ms`);
    console.log(`    batchTotal=${previewBody.batch.summary.total} valid=${previewBody.batch.summary.valid} imported=${confirmBody.summary.imported} skipped=${confirmBody.summary.skipped}`);
    if (confirmBody.summary.imported !== size) {
      console.log(`    MISMATCH — expected ${size} imported, got ${confirmBody.summary.imported}.`);
    }
  }

  } finally {
    // Always cleans up, even on error — see claude/prompts/24-testing.md, "Load harness cleanup".
    console.log("\nCleaning up...");
    const importedContacts = await db.select({ id: contacts.id }).from(contacts).where(like(contacts.referenceId, `${refPrefix}%`));
    for (const c of importedContacts) {
      await db.delete(contacts).where(eq(contacts.id, c.id));
    }
    if (adminUserId) {
      const batches = await db.select({ id: contactImportBatches.id }).from(contactImportBatches).where(eq(contactImportBatches.createdBy, adminUserId));
      for (const b of batches) {
        await db.delete(contactImportRows).where(eq(contactImportRows.batchId, b.id));
        await db.delete(contactImportBatches).where(eq(contactImportBatches.id, b.id));
      }
      await db.delete(users).where(eq(users.id, adminUserId));
      console.log(`Removed ${importedContacts.length} imported Contacts and ${batches.length} import batch(es). No residual PII left behind.`);
    }
    await app.close();
    await closeDb();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
