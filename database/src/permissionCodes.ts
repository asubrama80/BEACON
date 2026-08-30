/**
 * Module 03's user-administration permission codes — the single source of truth, shared by
 * the seed script and by backend authorization code (`requirePermission()`). Future modules
 * define and seed their own permission codes when they're implemented; this file intentionally
 * does not anticipate them.
 */
export const MODULE_03_PERMISSIONS = [
  { code: "users.read", name: "View users", description: "List and view registered BEACON users." },
  { code: "users.create", name: "Create users", description: "Create a new registered BEACON user." },
  {
    code: "users.update",
    name: "Update users",
    description: "Edit a registered user's safe metadata, and reset their password.",
  },
  {
    code: "users.disable",
    name: "Disable/enable users",
    description: "Disable or re-enable a registered user's access.",
  },
  {
    code: "users.roles.assign",
    name: "Assign user roles",
    description: "Assign or remove roles on a registered user.",
  },
  { code: "roles.read", name: "View roles", description: "List the system roles." },
  { code: "permissions.read", name: "View permissions", description: "List the available permission codes." },
] as const;

export type Module03PermissionCode = (typeof MODULE_03_PERMISSIONS)[number]["code"];

/**
 * Module 04's contact-management permission codes. Same convention: seeded once, never
 * renamed, shared by the seed script and `requirePermission()`. Future modules (Groups,
 * Alerts, Incidents, …) seed their own permissions when they're implemented.
 */
export const MODULE_04_PERMISSIONS = [
  { code: "contacts.read", name: "View contacts", description: "List and view BEACON contacts." },
  { code: "contacts.create", name: "Create contacts", description: "Create a new BEACON contact." },
  { code: "contacts.update", name: "Update contacts", description: "Edit a contact's details." },
  {
    code: "contacts.disable",
    name: "Disable/enable contacts",
    description: "Disable or re-enable a contact's active status.",
  },
] as const;

export type Module04PermissionCode = (typeof MODULE_04_PERMISSIONS)[number]["code"];

/**
 * Module 05's contact-import permission code. Kept in its own module file (even though the
 * code's resource prefix is still `contacts`) so each module continues to own exactly the
 * permissions it introduces, per the established per-module seeding convention.
 */
export const MODULE_05_PERMISSIONS = [
  {
    code: "contacts.import",
    name: "Import contacts",
    description: "Bulk-import contacts from an uploaded CSV or XLSX file.",
  },
] as const;

export type Module05PermissionCode = (typeof MODULE_05_PERMISSIONS)[number]["code"];

/**
 * Module 06's group-management permission codes. Same convention: seeded once, never renamed,
 * shared by the seed script and `requirePermission()`.
 */
export const MODULE_06_PERMISSIONS = [
  { code: "groups.read", name: "View groups", description: "List and view BEACON Contact Groups." },
  { code: "groups.create", name: "Create groups", description: "Create a new Contact Group." },
  { code: "groups.update", name: "Update groups", description: "Edit a Group's name/description." },
  {
    code: "groups.disable",
    name: "Disable/enable groups",
    description: "Disable or re-enable a Group's active status.",
  },
  {
    code: "groups.members.manage",
    name: "Manage group members",
    description: "Add or remove Contacts from a Group.",
  },
] as const;

export type Module06PermissionCode = (typeof MODULE_06_PERMISSIONS)[number]["code"];

/**
 * Module 07's template-management permission codes. Same convention: seeded once, never
 * renamed, shared by the seed script and `requirePermission()`.
 */
export const MODULE_07_PERMISSIONS = [
  { code: "templates.read", name: "View templates", description: "List and view BEACON message Templates." },
  { code: "templates.create", name: "Create templates", description: "Create a new message Template." },
  { code: "templates.update", name: "Update templates", description: "Edit a Template's content." },
  {
    code: "templates.disable",
    name: "Disable/enable templates",
    description: "Disable or re-enable a Template's active status.",
  },
] as const;

export type Module07PermissionCode = (typeof MODULE_07_PERMISSIONS)[number]["code"];

/**
 * Module 08's incident-management permission codes. Same convention: seeded once, never
 * renamed, shared by the seed script and `requirePermission()`.
 */
export const MODULE_08_PERMISSIONS = [
  { code: "incidents.read", name: "View incidents", description: "List and view BEACON Incidents." },
  { code: "incidents.create", name: "Create incidents", description: "Create a new Incident." },
  { code: "incidents.update", name: "Update incidents", description: "Edit an Incident's title/description/severity." },
  {
    code: "incidents.lifecycle.manage",
    name: "Manage incident lifecycle",
    description: "Activate, resolve, reopen, or close an Incident.",
  },
  {
    code: "incidents.commander.assign",
    name: "Assign incident commander",
    description: "Assign or change an Incident's commander.",
  },
  {
    code: "incidents.participants.manage",
    name: "Manage incident participants",
    description: "Add or remove Users/Contacts from an Incident's roster.",
  },
  {
    code: "incidents.timeline.read",
    name: "View incident timeline",
    description: "View an Incident's operational timeline.",
  },
] as const;

export type Module08PermissionCode = (typeof MODULE_08_PERMISSIONS)[number]["code"];

/**
 * Module 09's alert-engine permission codes. Same convention: seeded once, never renamed,
 * shared by the seed script and `requirePermission()`. `alerts.recipients.read` is deliberately
 * separate from `alerts.read` — recipient rows carry destination PII (phone/email), so viewing
 * them is gated independently. See claude/prompts/09-alert-engine.md, "Recipient PII permission".
 */
export const MODULE_09_PERMISSIONS = [
  { code: "alerts.read", name: "View alerts", description: "List and view BEACON Alerts (summary — no recipient PII)." },
  { code: "alerts.create", name: "Create alerts", description: "Create a new draft Alert." },
  { code: "alerts.update", name: "Update alerts", description: "Edit a draft Alert's content, audience, or context." },
  { code: "alerts.ready", name: "Ready alerts", description: "Resolve recipients and transition an Alert to READY." },
  { code: "alerts.cancel", name: "Cancel alerts", description: "Cancel a draft or ready Alert." },
  {
    code: "alerts.recipients.read",
    name: "View alert recipients",
    description: "View an Alert's resolved recipient list, including destination phone/email.",
  },
] as const;

export type Module09PermissionCode = (typeof MODULE_09_PERMISSIONS)[number]["code"];

/**
 * Module 10's notification-provider permission code. Same convention: seeded once, never
 * renamed, shared by the seed script and `requirePermission()`. Dispatch is deliberately its own
 * permission, separate from `alerts.ready` — approving a communication plan (READY) and actually
 * beginning external provider submission (Dispatch) are different operational decisions. See
 * claude/prompts/10-notification-providers.md, "Permissions".
 */
export const MODULE_10_PERMISSIONS = [
  {
    code: "alerts.dispatch",
    name: "Dispatch alerts",
    description: "Submit a READY Alert's recipients to the configured notification provider.",
  },
] as const;

export type Module10PermissionCode = (typeof MODULE_10_PERMISSIONS)[number]["code"];

/**
 * Module 11's delivery-tracking permission code. Gates recipient-level delivery EVENT history
 * (timestamps/error codes per event) as an additional check alongside `alerts.recipients.read`.
 * The safe aggregate delivery summary on an Alert's detail view needs no new permission — it's
 * visible to anyone who can already see the Alert (`alerts.read`). See
 * claude/prompts/11-delivery-tracking.md, "Permissions".
 */
export const MODULE_11_PERMISSIONS = [
  {
    code: "alerts.delivery.read",
    name: "View delivery events",
    description: "View an Alert recipient's detailed post-submission delivery event history.",
  },
] as const;

export type Module11PermissionCode = (typeof MODULE_11_PERMISSIONS)[number]["code"];

/**
 * Module 12's Incident Command Center permission code. Gates a single new read-only aggregate
 * endpoint (`GET /incidents/:id/command-center`) that projects existing Module 08-11 data — it
 * grants no new write capability and creates no parallel authorization model. See
 * claude/prompts/12-incident-command-center.md, "Permissions".
 */
export const MODULE_12_PERMISSIONS = [
  {
    code: "incidents.command_center.read",
    name: "View incident command center",
    description: "View the aggregated operational Command Center projection for an Incident.",
  },
] as const;

export type Module12PermissionCode = (typeof MODULE_12_PERMISSIONS)[number]["code"];
