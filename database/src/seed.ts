import { pathToFileURL } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { loadDatabaseConfig } from "./client.js";
import { roles, SYSTEM_ROLE_CODES, type SystemRoleCode } from "./schema/roles.js";
import { permissions } from "./schema/permissions.js";
import { rolePermissions } from "./schema/rolePermissions.js";
import {
  MODULE_03_PERMISSIONS,
  MODULE_04_PERMISSIONS,
  type Module03PermissionCode,
  type Module04PermissionCode,
} from "./permissionCodes.js";

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

const ALL_PERMISSIONS = [...MODULE_03_PERMISSIONS, ...MODULE_04_PERMISSIONS];
type AnyPermissionCode = Module03PermissionCode | Module04PermissionCode;

/**
 * ADMIN gets full administrative control of every seeded permission. Other roles are granted
 * only what's justified by their current, already-implemented job — see the module prompts
 * (claude/prompts/03-users-rbac.md, 04-contacts.md) for the reasoning behind each grant.
 */
const ROLE_PERMISSION_MAP: Record<SystemRoleCode, readonly AnyPermissionCode[]> = {
  ADMIN: ALL_PERMISSIONS.map((p) => p.code),
  AUDITOR: ["users.read", "roles.read", "permissions.read", "contacts.read"],
  INCIDENT_COMMANDER: ["contacts.read"],
  COMMUNICATION_MANAGER: ["contacts.read", "contacts.create", "contacts.update"],
  RESPONDER: [],
};

export async function seedPermissions(db: ReturnType<typeof drizzle>): Promise<void> {
  await db
    .insert(permissions)
    .values(ALL_PERMISSIONS.map(({ code, name, description }) => ({ code, name, description })))
    .onConflictDoNothing({ target: permissions.code });
}

export async function seedRolePermissions(db: ReturnType<typeof drizzle>): Promise<void> {
  const roleRows = await db.select({ id: roles.id, code: roles.code }).from(roles);
  const permissionRows = await db.select({ id: permissions.id, code: permissions.code }).from(permissions);

  const roleIdByCode = new Map(roleRows.map((r) => [r.code, r.id]));
  const permissionIdByCode = new Map(permissionRows.map((p) => [p.code, p.id]));

  const values: { roleId: string; permissionId: string }[] = [];
  for (const [roleCode, permissionCodes] of Object.entries(ROLE_PERMISSION_MAP)) {
    const roleId = roleIdByCode.get(roleCode);
    if (!roleId) continue;

    for (const permissionCode of permissionCodes) {
      const permissionId = permissionIdByCode.get(permissionCode);
      if (!permissionId) continue;
      values.push({ roleId, permissionId });
    }
  }

  if (values.length > 0) {
    await db
      .insert(rolePermissions)
      .values(values)
      .onConflictDoNothing({ target: [rolePermissions.roleId, rolePermissions.permissionId] });
  }
}

async function main(): Promise<void> {
  const config = loadDatabaseConfig();
  const seedClient = postgres(config.connectionString, { max: 1 });

  try {
    const db = drizzle(seedClient);
    await seedRoles(db);
    await seedPermissions(db);
    await seedRolePermissions(db);
    console.log(
      `Seed complete: ${SYSTEM_ROLE_CODES.length} system roles, ${ALL_PERMISSIONS.length} permissions ensured.`,
    );
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
