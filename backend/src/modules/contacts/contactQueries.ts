import { and, eq, ilike, ne, or, sql } from "drizzle-orm";
import { contacts, type Database } from "@beacon/database";
import type { ContactRow } from "./dto.js";

const SAFE_CONTACT_COLUMNS = {
  id: contacts.id,
  referenceId: contacts.referenceId,
  firstName: contacts.firstName,
  lastName: contacts.lastName,
  email: contacts.email,
  mobilePhone: contacts.mobilePhone,
  department: contacts.department,
  status: contacts.status,
  createdAt: contacts.createdAt,
  updatedAt: contacts.updatedAt,
} as const;

export async function findContactById(db: Database, id: string): Promise<ContactRow | undefined> {
  const [row] = await db.select(SAFE_CONTACT_COLUMNS).from(contacts).where(eq(contacts.id, id)).limit(1);
  return row;
}

export interface ListContactsFilter {
  search?: string;
  status?: string;
  page: number;
  pageSize: number;
}

export interface ListContactsResult {
  items: ContactRow[];
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

export async function listContacts(db: Database, filter: ListContactsFilter): Promise<ListContactsResult> {
  const conditions = [];
  if (filter.search) {
    const pattern = `%${filter.search}%`;
    conditions.push(
      or(
        ilike(contacts.firstName, pattern),
        ilike(contacts.lastName, pattern),
        ilike(contacts.email, pattern),
        ilike(contacts.mobilePhone, pattern),
      ),
    );
  }
  if (filter.status) {
    conditions.push(eq(contacts.status, filter.status));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [countRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(contacts)
    .where(whereClause);
  const total = countRow?.count ?? 0;

  const items = await db
    .select(SAFE_CONTACT_COLUMNS)
    .from(contacts)
    .where(whereClause)
    .orderBy(contacts.lastName, contacts.firstName)
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);

  return { items, total, page: filter.page, pageSize: filter.pageSize };
}

export interface DuplicateCandidate {
  id: string;
  firstName: string;
  lastName: string;
  matchedOn: ("email" | "mobilePhone")[];
}

/**
 * Finds contacts sharing a normalized email or phone with the given values — used to surface a
 * "this looks like an existing contact" warning, never to block or auto-merge. Excludes one
 * contact id (the record being updated, if any) so editing a contact doesn't flag itself.
 */
export async function findLikelyDuplicates(
  db: Database,
  values: { email?: string | undefined; mobilePhone?: string | undefined },
  excludeId?: string,
): Promise<DuplicateCandidate[]> {
  if (!values.email && !values.mobilePhone) {
    return [];
  }

  const matchConditions = [];
  if (values.email) matchConditions.push(eq(contacts.email, values.email));
  if (values.mobilePhone) matchConditions.push(eq(contacts.mobilePhone, values.mobilePhone));

  const conditions = [or(...matchConditions)!];
  if (excludeId) conditions.push(ne(contacts.id, excludeId));

  const rows = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      mobilePhone: contacts.mobilePhone,
    })
    .from(contacts)
    .where(and(...conditions));

  return rows.map((row) => ({
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    matchedOn: [
      ...(values.email && row.email === values.email ? (["email"] as const) : []),
      ...(values.mobilePhone && row.mobilePhone === values.mobilePhone ? (["mobilePhone"] as const) : []),
    ],
  }));
}
