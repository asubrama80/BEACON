import { and, eq } from "drizzle-orm";
import { roles, userRoles, users, type Database } from "@beacon/database";
import { AuthError } from "../auth/errors.js";
import { hashPassword } from "../auth/password.js";
import { validatePasswordPolicy } from "../auth/passwordPolicy.js";
import type { AuthConfig } from "../auth/config.js";
import { recordAuthEvent } from "../auth/audit.js";
import { revokeAllSessionsForUser } from "../auth/session.js";
import { getUserRoles, getEffectivePermissions } from "../rbac/permissions.js";
import { findActiveMfaCredential } from "../auth/userAuth.js";
import { assertNotLastActiveAdmin } from "./lastAdmin.js";
import { assertNotBreakGlass } from "./breakGlass.js";
import {
  findSafeUserById,
  findUserByEmailExact,
  listUsers as queryUsers,
  normalizePagination,
  type ListUsersFilter,
} from "./userQueries.js";
import { toUserSummaryDto, toUserDetailDto, type UserDetailDto, type UserSummaryDto } from "./dto.js";

async function loadDetail(db: Database, userId: string): Promise<UserDetailDto> {
  const user = await findSafeUserById(db, userId);
  if (!user) {
    throw new AuthError(404, "not_found", "User not found.");
  }
  const [roleRows, effectivePermissions, activeMfa] = await Promise.all([
    getUserRoles(db, userId),
    getEffectivePermissions(db, userId),
    findActiveMfaCredential(db, userId),
  ]);
  return toUserDetailDto(user, roleRows, [...effectivePermissions], !!activeMfa);
}

export interface ListUsersOptions {
  search?: string;
  status?: string;
  roleCode?: string;
  page?: number;
  pageSize?: number;
}

export interface ListUsersResponse {
  items: UserSummaryDto[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listUsers(db: Database, options: ListUsersOptions): Promise<ListUsersResponse> {
  const { page, pageSize } = normalizePagination(options.page, options.pageSize);
  const filter: ListUsersFilter = { ...options, page, pageSize };

  const result = await queryUsers(db, filter);
  const items = await Promise.all(
    result.items.map(async (user) => toUserSummaryDto(user, await getUserRoles(db, user.id))),
  );

  return { items, total: result.total, page: result.page, pageSize: result.pageSize };
}

export async function getUser(db: Database, userId: string): Promise<UserDetailDto> {
  return loadDetail(db, userId);
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  initialPassword: string;
  roleCodes?: string[];
}

export async function createUser(
  db: Database,
  input: CreateUserInput,
  config: AuthConfig,
  actorId: string,
): Promise<UserDetailDto> {
  const email = input.email.trim().toLowerCase();
  const displayName = input.displayName.trim();

  const existing = await findUserByEmailExact(db, email);
  if (existing) {
    throw new AuthError(409, "duplicate_email", "A user with this email already exists.");
  }

  const policyResult = validatePasswordPolicy(input.initialPassword, { email, displayName }, config);
  if (!policyResult.valid) {
    throw new AuthError(400, "invalid_request", policyResult.reason ?? "Password does not meet policy.");
  }

  const roleIds = await resolveRoleIds(db, input.roleCodes ?? []);
  const passwordHash = await hashPassword(input.initialPassword, config);

  const [created] = await db
    .insert(users)
    .values({ email, displayName, passwordHash })
    .returning({ id: users.id });
  if (!created) {
    throw new AuthError(500, "not_found", "User creation failed unexpectedly.");
  }

  if (roleIds.length > 0) {
    await db.insert(userRoles).values(roleIds.map((roleId) => ({ userId: created.id, roleId })));
  }

  await recordAuthEvent(db, {
    eventType: "USER_CREATED",
    actorId,
    resourceType: "user",
    resourceId: created.id,
    metadata: { email, roleCodes: input.roleCodes ?? [] },
  });

  return loadDetail(db, created.id);
}

export interface UpdateUserInput {
  email?: string;
  displayName?: string;
}

export async function updateUser(
  db: Database,
  userId: string,
  input: UpdateUserInput,
  actorId: string,
): Promise<UserDetailDto> {
  const current = await findSafeUserById(db, userId);
  if (!current) {
    throw new AuthError(404, "not_found", "User not found.");
  }
  assertNotBreakGlass(current);

  const patch: { email?: string; displayName?: string; updatedAt: Date } = { updatedAt: new Date() };

  if (input.email !== undefined) {
    const email = input.email.trim().toLowerCase();
    if (email !== current.email) {
      const existing = await findUserByEmailExact(db, email);
      if (existing && existing.id !== userId) {
        throw new AuthError(409, "duplicate_email", "A user with this email already exists.");
      }
      patch.email = email;
    }
  }
  if (input.displayName !== undefined) {
    patch.displayName = input.displayName.trim();
  }

  await db.update(users).set(patch).where(eq(users.id, userId));

  await recordAuthEvent(db, {
    eventType: "USER_UPDATED",
    actorId,
    resourceType: "user",
    resourceId: userId,
    metadata: { fields: Object.keys(input) },
  });

  return loadDetail(db, userId);
}

export async function disableUser(db: Database, userId: string, actorId: string): Promise<UserDetailDto> {
  const current = await findSafeUserById(db, userId);
  if (!current) {
    throw new AuthError(404, "not_found", "User not found.");
  }
  assertNotBreakGlass(current);
  await assertNotLastActiveAdmin(db, userId);

  await db.update(users).set({ status: "inactive", updatedAt: new Date() }).where(eq(users.id, userId));
  await revokeAllSessionsForUser(db, userId);

  await recordAuthEvent(db, { eventType: "USER_DISABLED", actorId, resourceType: "user", resourceId: userId });

  return loadDetail(db, userId);
}

export async function enableUser(db: Database, userId: string, actorId: string): Promise<UserDetailDto> {
  const current = await findSafeUserById(db, userId);
  if (!current) {
    throw new AuthError(404, "not_found", "User not found.");
  }
  assertNotBreakGlass(current);

  await db.update(users).set({ status: "active", updatedAt: new Date() }).where(eq(users.id, userId));
  // Deliberately does not restore any previously-revoked sessions — re-enabling requires a fresh login.

  await recordAuthEvent(db, { eventType: "USER_ENABLED", actorId, resourceType: "user", resourceId: userId });

  return loadDetail(db, userId);
}

async function resolveRoleIds(db: Database, roleCodes: string[]): Promise<string[]> {
  if (roleCodes.length === 0) {
    return [];
  }
  const rows = await db.select({ id: roles.id, code: roles.code }).from(roles);
  const byCode = new Map(rows.map((r) => [r.code, r.id]));

  return roleCodes.map((code) => {
    const id = byCode.get(code);
    if (!id) {
      throw new AuthError(400, "role_not_found", `Unknown role code: ${code}`);
    }
    return id;
  });
}

export async function assignRole(
  db: Database,
  userId: string,
  roleCode: string,
  actorId: string,
): Promise<UserDetailDto> {
  const current = await findSafeUserById(db, userId);
  if (!current) {
    throw new AuthError(404, "not_found", "User not found.");
  }
  assertNotBreakGlass(current);

  const [roleIdResolved] = await resolveRoleIds(db, [roleCode]);
  const roleId = roleIdResolved!;

  const [existing] = await db
    .select({ id: userRoles.id })
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)))
    .limit(1);
  if (existing) {
    throw new AuthError(409, "role_already_assigned", `User already has the ${roleCode} role.`);
  }

  await db.insert(userRoles).values({ userId, roleId });

  await recordAuthEvent(db, {
    eventType: "USER_ROLE_ASSIGNED",
    actorId,
    resourceType: "user",
    resourceId: userId,
    metadata: { roleCode },
  });

  return loadDetail(db, userId);
}

export async function removeRole(
  db: Database,
  userId: string,
  roleCode: string,
  actorId: string,
): Promise<UserDetailDto> {
  const current = await findSafeUserById(db, userId);
  if (!current) {
    throw new AuthError(404, "not_found", "User not found.");
  }
  assertNotBreakGlass(current);

  if (roleCode === "ADMIN") {
    await assertNotLastActiveAdmin(db, userId);
  }

  const [roleIdResolved] = await resolveRoleIds(db, [roleCode]);
  const roleId = roleIdResolved!;

  const deleted = await db
    .delete(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)))
    .returning({ id: userRoles.id });
  if (deleted.length === 0) {
    throw new AuthError(404, "not_found", `User does not have the ${roleCode} role.`);
  }

  await recordAuthEvent(db, {
    eventType: "USER_ROLE_REMOVED",
    actorId,
    resourceType: "user",
    resourceId: userId,
    metadata: { roleCode },
  });

  return loadDetail(db, userId);
}

export async function resetPassword(
  db: Database,
  userId: string,
  newPassword: string,
  config: AuthConfig,
  actorId: string,
): Promise<void> {
  const current = await findSafeUserById(db, userId);
  if (!current) {
    throw new AuthError(404, "not_found", "User not found.");
  }
  assertNotBreakGlass(current);

  const policyResult = validatePasswordPolicy(
    newPassword,
    { email: current.email, displayName: current.displayName },
    config,
  );
  if (!policyResult.valid) {
    throw new AuthError(400, "invalid_request", policyResult.reason ?? "Password does not meet policy.");
  }

  const passwordHash = await hashPassword(newPassword, config);
  await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
  await revokeAllSessionsForUser(db, userId);

  await recordAuthEvent(db, {
    eventType: "USER_PASSWORD_RESET",
    actorId,
    resourceType: "user",
    resourceId: userId,
  });
}
