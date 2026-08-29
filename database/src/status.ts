import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { loadDatabaseConfig } from "./client.js";
import { roles } from "./schema/roles.js";

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  const client = postgres(config.connectionString, { max: 1 });

  try {
    const db = drizzle(client);

    const migrations = await client`
      select hash, created_at
      from drizzle.__drizzle_migrations
      order by created_at asc
    `.catch((error: { code?: string }) => {
      // 42P01 = undefined_table: no migration has ever been applied yet.
      if (error.code === "42P01") {
        return [];
      }
      throw error;
    });

    console.log(`Applied migrations: ${migrations.length}`);
    for (const row of migrations) {
      const appliedAt = new Date(Number(row.created_at)).toISOString();
      console.log(`  - ${String(row.hash).slice(0, 12)} (${appliedAt})`);
    }

    const roleRows = await db.select({ code: roles.code }).from(roles);
    console.log(`Seeded roles: ${roleRows.length} (${roleRows.map((r) => r.code).join(", ")})`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error("Status check failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
