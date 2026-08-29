import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadDatabaseConfig } from "./client.js";

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  const migrationClient = postgres(config.connectionString, { max: 1 });

  try {
    const db = drizzle(migrationClient);
    await migrate(db, { migrationsFolder });
    console.log("Migrations applied successfully.");
  } finally {
    await migrationClient.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error("Migration failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
