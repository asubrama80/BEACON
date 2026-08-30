import { and, eq } from "drizzle-orm";
import { groups, groupMembers, type Database } from "@beacon/database";
import { AuthError } from "../auth/errors.js";
import { recordAuthEvent } from "../auth/audit.js";
import {
  findGroupById,
  findGroupByNameCaseInsensitive,
  listGroups as queryGroups,
  listMembers as queryMembers,
  findExistingContactIds,
  findExistingMemberContactIds,
  normalizePagination,
  type ListGroupsFilter,
} from "./groupQueries.js";
import { toGroupDto, toGroupMemberDto, type GroupDto, type GroupMemberDto } from "./dto.js";

const NAME_MAX_LENGTH = 255;
const DESCRIPTION_MAX_LENGTH = 2000;

function validateName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AuthError(400, "invalid_request", "Group name is required.");
  }
  if (trimmed.length > NAME_MAX_LENGTH) {
    throw new AuthError(400, "invalid_request", `Group name must be ${NAME_MAX_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

function validateDescription(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
    throw new AuthError(
      400,
      "invalid_request",
      `Description must be ${DESCRIPTION_MAX_LENGTH} characters or fewer.`,
    );
  }
  return trimmed || null;
}

async function assertNameAvailable(db: Database, name: string, excludeId?: string): Promise<void> {
  const existing = await findGroupByNameCaseInsensitive(db, name, excludeId);
  if (existing) {
    throw new AuthError(409, "duplicate_group_name", "A group with this name already exists.");
  }
}

async function loadDto(db: Database, id: string): Promise<GroupDto> {
  const row = await findGroupById(db, id);
  if (!row) {
    throw new AuthError(404, "not_found", "Group not found.");
  }
  return toGroupDto(row);
}

export interface ListGroupsOptions {
  search?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface ListGroupsResponse {
  items: GroupDto[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listGroups(db: Database, options: ListGroupsOptions): Promise<ListGroupsResponse> {
  const { page, pageSize } = normalizePagination(options.page, options.pageSize);
  const filter: ListGroupsFilter = { ...options, page, pageSize };
  const result = await queryGroups(db, filter);
  return { items: result.items.map(toGroupDto), total: result.total, page, pageSize };
}

export async function getGroup(db: Database, id: string): Promise<GroupDto> {
  return loadDto(db, id);
}

export interface CreateGroupInput {
  name: string;
  description?: string;
}

export async function createGroup(db: Database, input: CreateGroupInput, actorId: string): Promise<GroupDto> {
  const name = validateName(input.name);
  const description = validateDescription(input.description) ?? null;

  await assertNameAvailable(db, name);

  const [created] = await db.insert(groups).values({ name, description }).returning({ id: groups.id });
  if (!created) {
    throw new AuthError(500, "not_found", "Group creation failed unexpectedly.");
  }

  await recordAuthEvent(db, {
    eventType: "GROUP_CREATED",
    actorId,
    resourceType: "group",
    resourceId: created.id,
    metadata: { name },
  });

  return loadDto(db, created.id);
}

export interface UpdateGroupInput {
  name?: string;
  description?: string;
}

export async function updateGroup(
  db: Database,
  id: string,
  input: UpdateGroupInput,
  actorId: string,
): Promise<GroupDto> {
  const current = await findGroupById(db, id);
  if (!current) {
    throw new AuthError(404, "not_found", "Group not found.");
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  const changedFields: string[] = [];

  if (input.name !== undefined) {
    const name = validateName(input.name);
    if (name.toLowerCase() !== current.name.toLowerCase()) {
      await assertNameAvailable(db, name, id);
    }
    patch.name = name;
    changedFields.push("name");
  }
  if (input.description !== undefined) {
    patch.description = validateDescription(input.description);
    changedFields.push("description");
  }

  if (changedFields.length > 0) {
    await db.update(groups).set(patch).where(eq(groups.id, id));

    await recordAuthEvent(db, {
      eventType: "GROUP_UPDATED",
      actorId,
      resourceType: "group",
      resourceId: id,
      metadata: { fields: changedFields },
    });
  }

  return loadDto(db, id);
}

export async function disableGroup(db: Database, id: string, actorId: string): Promise<GroupDto> {
  const current = await findGroupById(db, id);
  if (!current) {
    throw new AuthError(404, "not_found", "Group not found.");
  }

  await db.update(groups).set({ status: "inactive", updatedAt: new Date() }).where(eq(groups.id, id));

  await recordAuthEvent(db, { eventType: "GROUP_DISABLED", actorId, resourceType: "group", resourceId: id });

  return loadDto(db, id);
}

export async function enableGroup(db: Database, id: string, actorId: string): Promise<GroupDto> {
  const current = await findGroupById(db, id);
  if (!current) {
    throw new AuthError(404, "not_found", "Group not found.");
  }

  await db.update(groups).set({ status: "active", updatedAt: new Date() }).where(eq(groups.id, id));

  await recordAuthEvent(db, { eventType: "GROUP_ENABLED", actorId, resourceType: "group", resourceId: id });

  return loadDto(db, id);
}

export interface ListMembersOptions {
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface ListMembersResponse {
  items: GroupMemberDto[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listMembers(
  db: Database,
  groupId: string,
  options: ListMembersOptions,
): Promise<ListMembersResponse> {
  const group = await findGroupById(db, groupId);
  if (!group) {
    throw new AuthError(404, "not_found", "Group not found.");
  }

  const { page, pageSize } = normalizePagination(options.page, options.pageSize);
  const result = await queryMembers(db, groupId, { search: options.search, page, pageSize });
  return { items: result.items.map(toGroupMemberDto), total: result.total, page, pageSize };
}

export interface AddMembersResult {
  added: string[];
  alreadyMember: string[];
  notFound: string[];
}

/**
 * Adds one or more existing Contacts to a Group. Never creates a Contact. A contact id that's
 * already a member, or that doesn't exist, is reported back rather than causing the whole
 * request to fail — bulk-add behavior stays predictable regardless of overlap with prior calls.
 */
export async function addMembers(
  db: Database,
  groupId: string,
  contactIds: string[],
  actorId: string,
): Promise<AddMembersResult> {
  const group = await findGroupById(db, groupId);
  if (!group) {
    throw new AuthError(404, "not_found", "Group not found.");
  }

  const uniqueIds = [...new Set(contactIds)];
  const existingContactIds = await findExistingContactIds(db, uniqueIds);
  const notFound = uniqueIds.filter((id) => !existingContactIds.has(id));
  const validIds = uniqueIds.filter((id) => existingContactIds.has(id));

  const alreadyMemberSet = await findExistingMemberContactIds(db, groupId, validIds);
  const alreadyMember = validIds.filter((id) => alreadyMemberSet.has(id));
  const toAdd = validIds.filter((id) => !alreadyMemberSet.has(id));

  if (toAdd.length > 0) {
    await db
      .insert(groupMembers)
      .values(toAdd.map((contactId) => ({ groupId, contactId })))
      .onConflictDoNothing({ target: [groupMembers.groupId, groupMembers.contactId] });

    await recordAuthEvent(db, {
      eventType: "GROUP_MEMBER_ADDED",
      actorId,
      resourceType: "group",
      resourceId: groupId,
      metadata: { addedContactIds: toAdd, addedCount: toAdd.length },
    });
  }

  return { added: toAdd, alreadyMember, notFound };
}

/**
 * Removes a single membership. Never touches the Contact row itself — the Contact continues to
 * exist, active or not, and keeps every other Group it belongs to.
 */
export async function removeMember(
  db: Database,
  groupId: string,
  contactId: string,
  actorId: string,
): Promise<void> {
  const group = await findGroupById(db, groupId);
  if (!group) {
    throw new AuthError(404, "not_found", "Group not found.");
  }

  const deleted = await db
    .delete(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.contactId, contactId)))
    .returning({ contactId: groupMembers.contactId });

  if (deleted.length > 0) {
    await recordAuthEvent(db, {
      eventType: "GROUP_MEMBER_REMOVED",
      actorId,
      resourceType: "group",
      resourceId: groupId,
      metadata: { contactId },
    });
  }
}
