import { and, desc, eq, lt } from "drizzle-orm";
import { chatMessages, users, type Database, type DbOrTx } from "@beacon/database";
import type { ChatMessageRow } from "./chatDto.js";

const MESSAGE_COLUMNS = {
  id: chatMessages.id,
  incidentId: chatMessages.incidentId,
  seq: chatMessages.seq,
  authorType: chatMessages.authorType,
  userId: chatMessages.userId,
  authorDisplayName: users.displayName,
  messageText: chatMessages.messageText,
  createdAt: chatMessages.createdAt,
} as const;

export interface InsertMessageInput {
  incidentId: string;
  userId: string;
  messageText: string;
}

/** Server-generated id/seq/createdAt — never accepted from the client. */
export async function insertMessage(db: DbOrTx, input: InsertMessageInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(chatMessages)
    .values({ incidentId: input.incidentId, authorType: "user", userId: input.userId, messageText: input.messageText })
    .returning({ id: chatMessages.id });
  if (!row) {
    throw new Error("Failed to insert chat message.");
  }
  return row;
}

export async function findMessageById(db: DbOrTx, id: string): Promise<ChatMessageRow | undefined> {
  const [row] = await db
    .select(MESSAGE_COLUMNS)
    .from(chatMessages)
    .leftJoin(users, eq(users.id, chatMessages.userId))
    .where(eq(chatMessages.id, id))
    .limit(1);
  return row;
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

export function normalizeLimit(limit?: number): number {
  return Number.isInteger(limit) && limit! > 0 ? Math.min(limit!, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
}

export interface ListMessagesFilter {
  /** Cursor-based pagination: fetch messages strictly older than this `seq` (exclusive). */
  beforeSeq?: number | undefined;
  limit: number;
}

/**
 * Cursor-based history fetch, ordered oldest-first for direct rendering. Internally queries
 * newest-first with a `seq` cursor (a stable, monotonic tiebreaker — never `created_at` alone,
 * which two concurrent senders could share) then reverses, so "load older messages" always means
 * "the `limit` messages immediately before this cursor," never an unbounded full-history scan. See
 * claude/prompts/13-realtime-incident-chat.md, "Message ordering" and "Message history".
 */
export async function listMessages(db: Database, incidentId: string, filter: ListMessagesFilter): Promise<ChatMessageRow[]> {
  const conditions = [eq(chatMessages.incidentId, incidentId)];
  if (filter.beforeSeq !== undefined) {
    conditions.push(lt(chatMessages.seq, filter.beforeSeq));
  }

  const rows = await db
    .select(MESSAGE_COLUMNS)
    .from(chatMessages)
    .leftJoin(users, eq(users.id, chatMessages.userId))
    .where(and(...conditions))
    .orderBy(desc(chatMessages.seq))
    .limit(filter.limit);

  return rows.reverse();
}
