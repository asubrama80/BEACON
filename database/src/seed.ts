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
  MODULE_05_PERMISSIONS,
  MODULE_06_PERMISSIONS,
  MODULE_07_PERMISSIONS,
  MODULE_08_PERMISSIONS,
  MODULE_09_PERMISSIONS,
  MODULE_10_PERMISSIONS,
  MODULE_11_PERMISSIONS,
  MODULE_12_PERMISSIONS,
  MODULE_13_PERMISSIONS,
  MODULE_14_PERMISSIONS,
  MODULE_17_PERMISSIONS,
  MODULE_20_PERMISSIONS,
  MODULE_22_PERMISSIONS,
  type Module03PermissionCode,
  type Module04PermissionCode,
  type Module05PermissionCode,
  type Module06PermissionCode,
  type Module07PermissionCode,
  type Module08PermissionCode,
  type Module09PermissionCode,
  type Module10PermissionCode,
  type Module11PermissionCode,
  type Module12PermissionCode,
  type Module13PermissionCode,
  type Module14PermissionCode,
  type Module17PermissionCode,
  type Module20PermissionCode,
  type Module22PermissionCode,
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

const ALL_PERMISSIONS = [
  ...MODULE_03_PERMISSIONS,
  ...MODULE_04_PERMISSIONS,
  ...MODULE_05_PERMISSIONS,
  ...MODULE_06_PERMISSIONS,
  ...MODULE_07_PERMISSIONS,
  ...MODULE_08_PERMISSIONS,
  ...MODULE_09_PERMISSIONS,
  ...MODULE_10_PERMISSIONS,
  ...MODULE_11_PERMISSIONS,
  ...MODULE_12_PERMISSIONS,
  ...MODULE_13_PERMISSIONS,
  ...MODULE_14_PERMISSIONS,
  ...MODULE_17_PERMISSIONS,
  ...MODULE_20_PERMISSIONS,
  ...MODULE_22_PERMISSIONS,
];
type AnyPermissionCode =
  | Module03PermissionCode
  | Module04PermissionCode
  | Module05PermissionCode
  | Module06PermissionCode
  | Module07PermissionCode
  | Module08PermissionCode
  | Module09PermissionCode
  | Module10PermissionCode
  | Module11PermissionCode
  | Module12PermissionCode
  | Module13PermissionCode
  | Module14PermissionCode
  | Module17PermissionCode
  | Module20PermissionCode
  | Module22PermissionCode;

/**
 * ADMIN gets full administrative control of every seeded permission. Other roles are granted
 * only what's justified by their current, already-implemented job — see the module prompts
 * (claude/prompts/03-users-rbac.md, 04-contacts.md, 05-excel-csv-import.md, 06-groups.md,
 * 07-templates.md, 08-incident-management.md) for the reasoning behind each grant.
 */
const ROLE_PERMISSION_MAP: Record<SystemRoleCode, readonly AnyPermissionCode[]> = {
  ADMIN: ALL_PERMISSIONS.map((p) => p.code),
  AUDITOR: [
    "users.read",
    "roles.read",
    "permissions.read",
    "contacts.read",
    "groups.read",
    "templates.read",
    "incidents.read",
    "incidents.timeline.read",
    "alerts.read",
    // Auditor's job is compliance/audit review of BEACON's own communications (see README's
    // "who did what and when" framing) — granted deliberately, not by default; see
    // claude/prompts/09-alert-engine.md, "Permission mapping".
    "alerts.recipients.read",
    "alerts.delivery.read",
    "incidents.command_center.read",
    "incidents.chat.read",
    "incidents.war_room.read",
    "incidents.guests.read",
    // Module 20 — this is the role's namesake capability: "Auditor" exists specifically to
    // review BEACON's own accountability record.
    "audit.read",
    // Module 22 — visibility into system/security status and role-to-permission mapping is
    // compliance-relevant, consistent with AUDITOR's existing broad-read-access pattern.
    // Deliberately read-only: AUDITOR never gets admin.manage (it never performs mutations
    // anywhere else in this codebase either).
    "admin.read",
  ],
  INCIDENT_COMMANDER: [
    // users.read is newly justified by Module 08: assigning/changing an Incident's commander
    // requires searching active BEACON Users, which reuses the existing users.read-gated
    // /users lookup endpoint rather than duplicating it behind a second permission (see
    // claude/prompts/08-incident-management.md, "Commander vs RBAC distinction"). Module 03
    // deliberately withheld this because nothing in the role's job justified it *at the time*;
    // Module 08 gives the role an actual, concrete need.
    "users.read",
    "contacts.read",
    "groups.read",
    "templates.read",
    "incidents.read",
    "incidents.create",
    "incidents.update",
    "incidents.lifecycle.manage",
    "incidents.commander.assign",
    "incidents.participants.manage",
    "incidents.timeline.read",
    "alerts.read",
    "alerts.create",
    "alerts.update",
    "alerts.ready",
    "alerts.cancel",
    "alerts.recipients.read",
    "alerts.dispatch",
    "alerts.delivery.read",
    "incidents.command_center.read",
    "incidents.chat.read",
    "incidents.chat.send",
    "incidents.war_room.read",
    "incidents.war_room.manage",
    "incidents.war_room.join",
    "incidents.guests.read",
    "incidents.guests.invite",
    "incidents.guests.revoke",
  ],
  COMMUNICATION_MANAGER: [
    "contacts.read",
    "contacts.create",
    "contacts.update",
    "contacts.import",
    "groups.read",
    "groups.create",
    "groups.update",
    "groups.disable",
    "groups.members.manage",
    "templates.read",
    "templates.create",
    "templates.update",
    "templates.disable",
    "incidents.read",
    "incidents.create",
    "incidents.timeline.read",
    "alerts.read",
    "alerts.create",
    "alerts.update",
    "alerts.ready",
    "alerts.cancel",
    "alerts.recipients.read",
    "alerts.dispatch",
    "alerts.delivery.read",
    "incidents.command_center.read",
    "incidents.chat.read",
    "incidents.chat.send",
    // Deliberately read + join only, not manage — mirrors this role's existing exclusion from
    // incidents.lifecycle.manage; opening/ending the War Room is an Incident Commander-level
    // operational decision. See claude/prompts/14-war-room-foundation.md, "Permissions".
    "incidents.war_room.read",
    "incidents.war_room.join",
    "incidents.guests.read",
    "incidents.guests.invite",
    "incidents.guests.revoke",
  ],
  RESPONDER: [
    "incidents.read",
    "incidents.timeline.read",
    "alerts.read",
    // Deliberately withheld: recipient rows carry destination phone/email PII, and nothing in
    // this role's job requires seeing it. See claude/prompts/09-alert-engine.md.
    // Command Center authorization is currently global (matches incidents.read's existing
    // global model — no row-level "assigned incident" concept exists yet); granted here per
    // the module spec's explicit fallback: "If row-level security is ambiguous, retain current
    // global permission model." See claude/prompts/12-incident-command-center.md, "Permissions".
    "incidents.command_center.read",
    "incidents.chat.read",
    "incidents.chat.send",
    "incidents.war_room.read",
    "incidents.war_room.join",
    // Read-only — RESPONDER can see who's been invited but cannot invite/revoke, consistent
    // with its existing exclusion from every other *.manage-style permission in this codebase.
    "incidents.guests.read",
  ],
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
