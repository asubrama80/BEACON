import { and, eq, ilike, isNull, ne, sql } from "drizzle-orm";
import { templates, type Database, type DbOrTx } from "@beacon/database";
import type { TemplateRow } from "./dto.js";

const SAFE_TEMPLATE_COLUMNS = {
  id: templates.id,
  name: templates.name,
  channel: templates.channel,
  subject: templates.subject,
  body: templates.body,
  status: templates.status,
  createdAt: templates.createdAt,
  updatedAt: templates.updatedAt,
} as const;

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export function normalizePagination(page?: number, pageSize?: number): { page: number; pageSize: number } {
  const normalizedPage = Number.isInteger(page) && page! > 0 ? page! : 1;
  const normalizedPageSize =
    Number.isInteger(pageSize) && pageSize! > 0 ? Math.min(pageSize!, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  return { page: normalizedPage, pageSize: normalizedPageSize };
}

export interface ListTemplatesFilter {
  search?: string | undefined;
  channel?: string | undefined;
  status?: string | undefined;
  page: number;
  pageSize: number;
}

export interface ListTemplatesResult {
  items: TemplateRow[];
  total: number;
}

export async function listTemplates(db: Database, filter: ListTemplatesFilter): Promise<ListTemplatesResult> {
  const conditions = [isNull(templates.deletedAt)];
  if (filter.search) conditions.push(ilike(templates.name, `%${filter.search}%`));
  if (filter.channel) conditions.push(eq(templates.channel, filter.channel));
  if (filter.status) conditions.push(eq(templates.status, filter.status));
  const whereClause = and(...conditions);

  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(templates).where(whereClause);
  const total = countRow?.count ?? 0;

  const items = await db
    .select(SAFE_TEMPLATE_COLUMNS)
    .from(templates)
    .where(whereClause)
    .orderBy(templates.name)
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);

  return { items, total };
}

export async function findTemplateById(db: DbOrTx, id: string): Promise<TemplateRow | undefined> {
  const [row] = await db
    .select(SAFE_TEMPLATE_COLUMNS)
    .from(templates)
    .where(and(eq(templates.id, id), isNull(templates.deletedAt)))
    .limit(1);
  return row;
}

/** Case-insensitive uniqueness check scoped to the same channel and non-deleted Templates. */
export async function findTemplateByNameAndChannel(
  db: Database,
  name: string,
  channel: string,
  excludeId?: string,
): Promise<{ id: string } | undefined> {
  const conditions = [
    isNull(templates.deletedAt),
    eq(templates.channel, channel),
    sql`lower(${templates.name}) = lower(${name})`,
  ];
  if (excludeId) conditions.push(ne(templates.id, excludeId));
  const [row] = await db
    .select({ id: templates.id })
    .from(templates)
    .where(and(...conditions))
    .limit(1);
  return row;
}
