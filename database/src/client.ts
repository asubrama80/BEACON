import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import * as schema from "./schema/index.js";

export interface DatabaseConfig {
  connectionString: string;
}

/** Throws a clear, config-only error (never a raw connection error) if DATABASE_URL is missing. */
export function loadDatabaseConfig(source: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const connectionString = source.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is required but was not set. Copy .env.example to .env and configure it.",
    );
  }
  return { connectionString };
}

export type Database = PostgresJsDatabase<typeof schema>;

let sqlClient: postgres.Sql | undefined;
let database: Database | undefined;

/** Builds (once) and returns the single reusable connection pool. Never opens a new pool per call. */
export function getDb(config: DatabaseConfig = loadDatabaseConfig()): Database {
  if (!database) {
    sqlClient = postgres(config.connectionString, {
      max: 10,
      connect_timeout: 5,
      onnotice: () => {
        // Suppress routine PostgreSQL NOTICE output.
      },
    });
    database = drizzle(sqlClient, { schema });
  }
  return database;
}

export interface DatabaseHealth {
  connected: boolean;
}

/**
 * Reports database connectivity without ever throwing and without leaking the connection
 * string or any credential in the returned value.
 */
export async function checkDatabaseHealth(): Promise<DatabaseHealth> {
  try {
    const db = getDb();
    await db.execute(sql`select 1`);
    return { connected: true };
  } catch {
    return { connected: false };
  }
}

/** Closes the pool gracefully. Safe to call even if the pool was never opened. */
export async function closeDb(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = undefined;
    database = undefined;
  }
}
