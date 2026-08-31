import type { UserRoleRecord } from "../rbac/permissions.js";

/**
 * Explicit response shapes — never a raw DB row. This is what prevents password_hash, MFA
 * ciphertext, session/recovery-code hashes, and other authentication internals from ever
 * reaching a client, even by accident: those columns are never selected into a `UserRecord`
 * in the first place (see `userQueries.ts`), so there's nothing sensitive to leak here.
 */
export interface UserSummaryDto {
  id: string;
  email: string;
  displayName: string;
  status: string;
  isBreakGlass: boolean;
  roles: { id: string; code: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface UserDetailDto extends UserSummaryDto {
  effectivePermissions: string[];
  /** Module 22 — whether MFA is currently enabled, so Administration can offer an MFA-reset
   * action only when one is actually applicable. Never the secret itself. */
  mfaEnabled: boolean;
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  status: string;
  isBreakGlass: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export function toUserSummaryDto(user: UserRow, roles: UserRoleRecord[]): UserSummaryDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    isBreakGlass: user.isBreakGlass,
    roles: roles.map((role) => ({ id: role.id, code: role.code, name: role.name })),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export function toUserDetailDto(
  user: UserRow,
  roles: UserRoleRecord[],
  effectivePermissions: string[],
  mfaEnabled: boolean,
): UserDetailDto {
  return {
    ...toUserSummaryDto(user, roles),
    effectivePermissions: [...effectivePermissions].sort(),
    mfaEnabled,
  };
}
