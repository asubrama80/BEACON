/** Explicit response shape — never a raw DB row spread directly into a response. */
export interface GroupDto {
  id: string;
  name: string;
  description: string | null;
  status: string;
  /** Every membership row, regardless of the member Contact's active/inactive status. */
  memberCount: number;
  /** Memberships whose Contact is currently active. */
  activeMemberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  memberCount: number;
  activeMemberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export function toGroupDto(group: GroupRow): GroupDto {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    status: group.status,
    memberCount: group.memberCount,
    activeMemberCount: group.activeMemberCount,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

/**
 * A Group member's safe Contact fields plus membership metadata. Never a User/auth field —
 * Groups only ever contain Contacts (see CLAUDE.md: Users and Contacts are separate concepts).
 */
export interface GroupMemberDto {
  contactId: string;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  mobilePhone: string | null;
  department: string | null;
  referenceId: string | null;
  /** The member Contact's own active/inactive status — surfaced so inactive members are never hidden silently. */
  contactStatus: string;
  addedAt: string;
}

export interface GroupMemberRow {
  contactId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  mobilePhone: string | null;
  department: string | null;
  referenceId: string | null;
  contactStatus: string;
  addedAt: Date;
}

export function toGroupMemberDto(row: GroupMemberRow): GroupMemberDto {
  return {
    contactId: row.contactId,
    displayName: `${row.firstName} ${row.lastName}`.trim(),
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    mobilePhone: row.mobilePhone,
    department: row.department,
    referenceId: row.referenceId,
    contactStatus: row.contactStatus,
    addedAt: row.addedAt.toISOString(),
  };
}
