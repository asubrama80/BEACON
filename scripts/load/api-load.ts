/**
 * Module 24 — lightweight local API load harness. Establishes an observed local baseline, not a
 * production capacity guarantee: local developer workstation results are not production
 * performance guarantees. Never runs as part of the normal test suite (per the module spec's own
 * instruction) — invoke directly:
 *
 *   npx tsx scripts/load/api-load.ts
 *
 * Requires DATABASE_URL to be reachable (uses the real backend app against the real dev/test
 * database) and a seeded ADMIN-capable role. Creates and cleans up its own synthetic Admin user
 * and Incidents; never touches real data.
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq } from "drizzle-orm";
import { getDb, users, roles, userRoles, incidents, auditLogs, closeDb } from "@beacon/database";
import { buildApp } from "../../backend/src/app.js";
import { loadEnv } from "../../backend/src/config/env.js";

loadDotenv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });

interface RunResult {
  scenario: string;
  concurrency: number;
  requests: number;
  errors: number;
  latenciesMs: number[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function summarize(result: RunResult): void {
  const sorted = [...result.latenciesMs].sort((a, b) => a - b);
  console.log(
    `  [${result.scenario}] concurrency=${result.concurrency} requests=${result.requests} errors=${result.errors} ` +
      `p50=${percentile(sorted, 50).toFixed(1)}ms p95=${percentile(sorted, 95).toFixed(1)}ms p99=${percentile(sorted, 99).toFixed(1)}ms max=${(sorted[sorted.length - 1] ?? 0).toFixed(1)}ms`,
  );
}

async function runScenario(scenario: string, concurrency: number, totalRequests: number, fn: () => Promise<Response>): Promise<RunResult> {
  const latencies: number[] = [];
  let errors = 0;
  let launched = 0;

  async function worker(): Promise<void> {
    while (launched < totalRequests) {
      launched += 1;
      const start = performance.now();
      try {
        const res = await fn();
        if (!res.ok) errors += 1;
      } catch {
        errors += 1;
      }
      latencies.push(performance.now() - start);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return { scenario, concurrency, requests: totalRequests, errors, latenciesMs: latencies };
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
  const createdUserIds: string[] = [];
  const createdIncidentIds: string[] = [];

  console.log(`API load harness — base URL ${baseUrl}\n`);

  try {
  // Set up one synthetic Admin session and a handful of Incidents so /dashboard, incident list,
  // and audit list all have representative (but small, synthetic) data to read.
  const [adminRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, "ADMIN")).limit(1);
  const email = `test-c24-load-admin-${randomUUID()}@example.invalid`;
  const { hashPassword } = await import("../../backend/src/modules/auth/password.js");
  const { loadAuthConfig } = await import("../../backend/src/modules/auth/config.js");
  const authConfig = loadAuthConfig();
  const passwordHash = await hashPassword("Correct-Horse-Battery-C24-Load", authConfig);
  const [adminUser] = await db.insert(users).values({ email, displayName: "Load Test Admin", passwordHash }).returning({ id: users.id });
  createdUserIds.push(adminUser!.id);
  await db.insert(userRoles).values({ userId: adminUser!.id, roleId: adminRole!.id });

  const loginRes = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "Correct-Horse-Battery-C24-Load" }),
  });
  const setCookieHeaders = loginRes.headers.getSetCookie?.() ?? [];
  const sessionCookie = setCookieHeaders.map((c) => c.split(";")[0]).join("; ");
  const csrfCookie = setCookieHeaders.find((c) => c.startsWith(`${authConfig.csrfCookieName}=`));
  const csrfToken = csrfCookie ? csrfCookie.split(";")[0]!.split("=")[1]! : "";

  for (let i = 0; i < 10; i += 1) {
    const created = await fetch(`${baseUrl}/incidents`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: sessionCookie, "x-csrf-token": csrfToken },
      body: JSON.stringify({ title: `Load Test Incident ${i}`, severity: "warning" }),
    });
    if (!created.ok) {
      throw new Error(`Failed to seed a load-test Incident: ${created.status} ${await created.text()}`);
    }
    const body = (await created.json()) as { incident: { id: string } };
    createdIncidentIds.push(body.incident.id);
  }

  const tiers = [10, 25, 50];
  const results: RunResult[] = [];

  for (const concurrency of tiers) {
    results.push(await runScenario("GET /health", concurrency, concurrency * 5, () => fetch(`${baseUrl}/health`)));
  }
  for (const concurrency of tiers) {
    results.push(
      await runScenario("GET /dashboard (authenticated)", concurrency, concurrency * 5, () =>
        fetch(`${baseUrl}/dashboard`, { headers: { cookie: sessionCookie } }),
      ),
    );
  }
  for (const concurrency of tiers) {
    results.push(
      await runScenario("GET /incidents (authenticated, list)", concurrency, concurrency * 5, () =>
        fetch(`${baseUrl}/incidents`, { headers: { cookie: sessionCookie } }),
      ),
    );
  }
  for (const concurrency of tiers) {
    results.push(
      await runScenario("GET /audit (authenticated, list)", concurrency, concurrency * 5, () =>
        fetch(`${baseUrl}/audit`, { headers: { cookie: sessionCookie } }),
      ),
    );
  }

  console.log("\nResults:");
  for (const result of results) summarize(result);

  const totalErrors = results.reduce((sum, r) => sum + r.errors, 0);
  console.log(totalErrors === 0 ? "\nNo request errors observed." : `\n${totalErrors} request error(s) observed — see above.`);
  } finally {
    // Always cleans up, even on error — an earlier version of this harness left synthetic Admin
    // users/Incidents behind on failure, which polluted the shared dev database and broke
    // unrelated tests (e.g. last-admin-count assertions) until manually cleaned up. See
    // claude/prompts/24-testing.md, "Load harness cleanup".
    for (const id of createdIncidentIds) {
      await db.delete(auditLogs).where(eq(auditLogs.incidentId, id));
      await db.delete(incidents).where(eq(incidents.id, id));
    }
    for (const id of createdUserIds) {
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
      await db.delete(users).where(eq(users.id, id));
    }
    await app.close();
    await closeDb();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
