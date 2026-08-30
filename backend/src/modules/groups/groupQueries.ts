import { and, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { groups, groupMembers, contacts, type Database } from "@beacon/database";
import type { GroupMemberRow, GroupRow } from "./dto.js";

const MEMBER_COUNT = sql<number>`count(${groupMembers.id})::int`;
const ACTIVE_MEMBER_COUNT = sql<number>`count(${groupMembers.id}) filter (where ${contacts.status} = 'active')::int`;

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export function normalizePagination(page?: number, pageSize?: number): { page: number; pageSize: number } {
  const normalizedPage = Number.isInteger(page) && page! > 0 ? page! : 1;
  const normalizedPageSize =
    Number.isInteger(pageSize) && pageSize! > 0 ? Math.min(pageSize!, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  return { page: normalizedPage, pageSize: normalizedPageSize };
}

export interface ListGroupsFilter {
  search?: string;
  status?: string;
  page: number;
  pageSize: number;
}

export interface ListGroupsResult {
  items: GroupRow[];
  total: number;
}

/** One aggregated query per page (group + member counts) — avoids N+1 per-group count lookups. */
export async function listGroups(db: Database, filter: ListGroupsFilter): Promise<ListGroupsResult> {
  const conditions = [isNull(groups.deletedAt)];
  if (filter.search) conditions.push(ilike(groups.name, `%${filter.search}%`));
  if (filter.status) conditions.push(eq(groups.status, filter.status));
  const whereClause = and(...conditions);

  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(groups).where(whereClause);
  const total = countRow?.count ?? 0;

  const items = await db
    .select({
      id: groups.id,
      name: groups.name,
      description: groups.description,
      status: groups.status,
      createdAt: groups.createdAt,
      updatedAt: groups.updatedAt,
      memberCount: MEMBER_COUNT,
      activeMemberCount: ACTIVE_MEMBER_COUNT,
    })
    .from(groups)
    .leftJoin(groupMembers, eq(groupMembers.groupId, groups.id))
    .leftJoin(contacts, eq(contacts.id, groupMembers.contactId))
    .where(whereClause)
    .groupBy(groups.id)
    .orderBy(groups.name)
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);

  return { items, total };
}

export async function findGroupById(db: Database, id: string): Promise<GroupRow | undefined> {
  const [row] = await db
    .select({
      id: groups.id,
      name: groups.name,
      description: groups.description,
      status: groups.status,
      createdAt: groups.createdAt,
      updatedAt: groups.updatedAt,
      memberCount: MEMBER_COUNT,
      activeMemberCount: ACTIVE_MEMBER_COUNT,
    })
    .from(groups)
    .leftJoin(groupMembers, eq(groupMembers.groupId, groups.id))
    .leftJoin(contacts, eq(contacts.id, groupMembers.contactId))
    .where(and(eq(groups.id, id), isNull(groups.deletedAt)))
    .groupBy(groups.id)
    .limit(1);
  return row;
}

/** Case-insensitive uniqueness check among non-deleted groups — disabling a group never frees its name. */
export async function findGroupByNameCaseInsensitive(
  db: Database,
  name: string,
  excludeId?: string,
): Promise<{ id: string } | undefined> {
  const conditions = [isNull(groups.deletedAt), sql`lower(${groups.name}) = lower(${name})`];
  if (excludeId) conditions.push(ne(groups.id, excludeId));
  const [row] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(...conditions))
    .limit(1);
  return row;
}

export interface ListMembersFilter {
  search?: string | undefined;
  page: number;
  pageSize: number;
}

export interface ListMembersResult {
  items: GroupMemberRow[];
  total: number;
}

export async function listMembers(
  db: Database,
  groupId: string,
  filter: ListMembersFilter,
): Promise<ListMembersResult> {
  const conditions = [eq(groupMembers.groupId, groupId)];
  if (filter.search) {
    const pattern = `%${filter.search}%`;
    conditions.push(
      or(
        ilike(contacts.firstName, pattern),
        ilike(contacts.lastName, pattern),
        ilike(contacts.email, pattern),
        ilike(contacts.mobilePhone, pattern),
      )!,
    );
  }
  const whereClause = and(...conditions);

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(groupMembers)
    .innerJoin(contacts, eq(contacts.id, groupMembers.contactId))
    .where(whereClause);
  const total = countRow?.count ?? 0;

  const items = await db
    .select({
      contactId: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      mobilePhone: contacts.mobilePhone,
      department: contacts.department,
      referenceId: contacts.referenceId,
      contactStatus: contacts.status,
      addedAt: groupMembers.createdAt,
    })
    .from(groupMembers)
    .innerJoin(contacts, eq(contacts.id, groupMembers.contactId))
    .where(whereClause)
    .orderBy(contacts.lastName, contacts.firstName)
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);

  return { items, total };
}

/** Reusable membership boundary for a future Module 09 — raw member Contact ids, no filtering. */
export async function getGroupMemberContactIds(db: Database, groupId: string): Promise<string[]> {
  const rows = await db
    .select({ contactId: groupMembers.contactId })
    .from(groupMembers)
    .where(eq(groupMembers.groupId, groupId));
  return rows.map((r) => r.contactId);
}

export async function findExistingContactIds(db: Database, contactIds: string[]): Promise<Set<string>> {
  if (contactIds.length === 0) return new Set();
  const rows = await db.select({ id: contacts.id }).from(contacts).where(inArray(contacts.id, contactIds));
  return new Set(rows.map((r) => r.id));
}

export async function findExistingMemberContactIds(
  db: Database,
  groupId: string,
  contactIds: string[],
): Promise<Set<string>> {
  if (contactIds.length === 0) return new Set();
  const rows = await db
    .select({ contactId: groupMembers.contactId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, groupId), inArray(groupMembers.contactId, contactIds)));
  return new Set(rows.map((r) => r.contactId));
}
