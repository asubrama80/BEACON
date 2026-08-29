import { and, eq, ilike, or, sql } from "drizzle-orm";
import { users, userRoles, roles, type Database } from "@beacon/database";
import type { UserRow } from "./dto.js";

// Deliberately never selects password_hash or any other authentication-secret column —
// this is the query layer backing the user-administration API, which must never expose them.
const SAFE_USER_COLUMNS = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  status: users.status,
  isBreakGlass: users.isBreakGlass,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
} as const;

export async function findSafeUserById(db: Database, id: string): Promise<UserRow | undefined> {
  const [row] = await db.select(SAFE_USER_COLUMNS).from(users).where(eq(users.id, id)).limit(1);
  return row;
}

export interface ListUsersFilter {
  search?: string;
  status?: string;
  roleCode?: string;
  page: number;
  pageSize: number;
}

export interface ListUsersResult {
  items: UserRow[];
  total: number;
  page: number;
  pageSize: number;
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export function normalizePagination(page?: number, pageSize?: number): { page: number; pageSize: number } {
  const normalizedPage = Number.isInteger(page) && page! > 0 ? page! : 1;
  const normalizedPageSize =
    Number.isInteger(pageSize) && pageSize! > 0 ? Math.min(pageSize!, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  return { page: normalizedPage, pageSize: normalizedPageSize };
}

export async function listUsers(db: Database, filter: ListUsersFilter): Promise<ListUsersResult> {
  const conditions = [];
  if (filter.search) {
    const pattern = `%${filter.search}%`;
    conditions.push(or(ilike(users.email, pattern), ilike(users.displayName, pattern)));
  }
  if (filter.status) {
    conditions.push(eq(users.status, filter.status));
  }

  let userIdsWithRole: string[] | undefined;
  if (filter.roleCode) {
    const roleRows = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(roles.code, filter.roleCode));
    userIdsWithRole = roleRows.map((r) => r.userId);
    if (userIdsWithRole.length === 0) {
      return { items: [], total: 0, page: filter.page, pageSize: filter.pageSize };
    }
    conditions.push(sql`${users.id} = ANY(${userIdsWithRole})`);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(whereClause);
  const count = countRow?.count ?? 0;

  const items = await db
    .select(SAFE_USER_COLUMNS)
    .from(users)
    .where(whereClause)
    .orderBy(users.createdAt)
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);

  return { items, total: count, page: filter.page, pageSize: filter.pageSize };
}

export async function findUserByEmailExact(db: Database, email: string): Promise<UserRow | undefined> {
  const [row] = await db
    .select(SAFE_USER_COLUMNS)
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);
  return row;
}
