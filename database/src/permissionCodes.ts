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
