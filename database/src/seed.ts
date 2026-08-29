import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { loadDatabaseConfig } from "./client.js";
import { roles, SYSTEM_ROLE_CODES, type SystemRoleCode } from "./schema/roles.js";

const ROLE_NAMES: Record<SystemRoleCode, string> = {
  ADMIN: "Administrator",
  INCIDENT_COMMANDER: "Incident Commander",
  COMMUNICATION_MANAGER: "Communication Manager",
  RESPONDER: "Responder",
  AUDITOR: "Auditor",
};

const ROLE_DESCRIPTIONS: Record<SystemRoleCode, string> = {
  ADMIN: "Full administrative access to the BEACON system.",
  INCIDENT_COMMANDER: "Leads and directs the response to an active incident.",
  COMMUNICATION_MANAGER: "Manages alert composition and delivery for an incident.",
  RESPONDER: "Registered responder who participates in incident War Rooms.",
  AUDITOR: "Read-only access for compliance and audit review.",
};

export async function seedRoles(db: ReturnType<typeof drizzle>): Promise<void> {
  const values = SYSTEM_ROLE_CODES.map((code) => ({
    code,
    name: ROLE_NAMES[code],
    description: ROLE_DESCRIPTIONS[code],
  }));

  await db.insert(roles).values(values).onConflictDoNothing({ target: roles.code });
}

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  const seedClient = postgres(config.connectionString, { max: 1 });

  try {
    const db = drizzle(seedClient);
    await seedRoles(db);
    console.log(`Seed complete: ${SYSTEM_ROLE_CODES.length} system roles ensured.`);
  } finally {
    await seedClient.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error("Seed failed:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
