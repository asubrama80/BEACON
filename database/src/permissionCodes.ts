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
