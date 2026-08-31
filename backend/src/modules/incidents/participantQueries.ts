import { and, eq, ne, sql } from "drizzle-orm";
import { incidentParticipants, users, contacts, guestInvitations, type Database, type DbOrTx } from "@beacon/database";
import type { ParticipantRow } from "./dto.js";

const PARTICIPANT_COLUMNS = {
  id: incidentParticipants.id,
  participantType: incidentParticipants.participantType,
  participantRole: incidentParticipants.participantRole,
  status: incidentParticipants.status,
  userId: incidentParticipants.userId,
  contactId: incidentParticipants.contactId,
  guestInvitationId: incidentParticipants.guestInvitationId,
  userDisplayName: users.displayName,
  userStatus: users.status,
  contactFirstName: contacts.firstName,
  contactLastName: contacts.lastName,
  contactEmail: contacts.email,
  contactMobilePhone: contacts.mobilePhone,
  contactStatus: contacts.status,
  guestName: guestInvitations.guestName,
  guestInvitationStatus: guestInvitations.status,
  guestPermissions: guestInvitations.permissions,
  guestVerifiedAt: guestInvitations.verifiedAt,
  createdAt: incidentParticipants.createdAt,
} as const;

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

export function normalizePagination(page?: number, pageSize?: number): { page: number; pageSize: number } {
  const normalizedPage = Number.isInteger(page) && page! > 0 ? page! : 1;
  const normalizedPageSize =
    Number.isInteger(pageSize) && pageSize! > 0 ? Math.min(pageSize!, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  return { page: normalizedPage, pageSize: normalizedPageSize };
}

export async function findActiveParticipantByUser(
  tx: DbOrTx,
  incidentId: string,
  userId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: incidentParticipants.id })
    .from(incidentParticipants)
    .where(
      and(
        eq(incidentParticipants.incidentId, incidentId),
        eq(incidentParticipants.userId, userId),
        ne(incidentParticipants.status, "removed"),
      ),
    )
    .limit(1);
  return row;
}

export async function findActiveParticipantByContact(
  tx: DbOrTx,
  incidentId: string,
  contactId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: incidentParticipants.id })
    .from(incidentParticipants)
    .where(
      and(
        eq(incidentParticipants.incidentId, incidentId),
        eq(incidentParticipants.contactId, contactId),
        ne(incidentParticipants.status, "removed"),
      ),
    )
    .limit(1);
  return row;
}

export async function insertUserParticipant(tx: DbOrTx, incidentId: string, userId: string): Promise<{ id: string }> {
  const [row] = await tx
    .insert(incidentParticipants)
    .values({ incidentId, participantType: "user", userId, status: "joined" })
    .returning({ id: incidentParticipants.id });
  if (!row) throw new Error("Participant insert failed unexpectedly.");
  return row;
}

export async function insertContactParticipant(
  tx: DbOrTx,
  incidentId: string,
  contactId: string,
): Promise<{ id: string }> {
  const [row] = await tx
    .insert(incidentParticipants)
    .values({ incidentId, participantType: "contact", contactId, status: "joined" })
    .returning({ id: incidentParticipants.id });
  if (!row) throw new Error("Participant insert failed unexpectedly.");
  return row;
}

/**
 * Module 19 — the auto-enrollment insert for a just-verified Guest. Race-safety comes from
 * `incident_participants_active_guest_idx` (the same partial-unique-index pattern as the User/
 * Contact variants), not this function alone; the caller (`guestVerificationService.verifyOtp()`)
 * only ever reaches this once per invitation because it's gated on `markInvitationVerified()`'s
 * own idempotent first-time-only return value. See claude/prompts/19-participant-management.md,
 * "Auto-enrollment".
 */
export async function insertGuestParticipant(tx: DbOrTx, incidentId: string, guestInvitationId: string): Promise<{ id: string }> {
  const [row] = await tx
    .insert(incidentParticipants)
    .values({ incidentId, participantType: "guest", guestInvitationId, status: "joined" })
    .returning({ id: incidentParticipants.id });
  if (!row) throw new Error("Participant insert failed unexpectedly.");
  return row;
}

export async function findActiveParticipantByGuestInvitation(
  tx: DbOrTx,
  incidentId: string,
  guestInvitationId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await tx
    .select({ id: incidentParticipants.id })
    .from(incidentParticipants)
    .where(
      and(
        eq(incidentParticipants.incidentId, incidentId),
        eq(incidentParticipants.guestInvitationId, guestInvitationId),
        ne(incidentParticipants.status, "removed"),
      ),
    )
    .limit(1);
  return row;
}

export async function findParticipantRowById(
  tx: DbOrTx,
  incidentId: string,
  participantId: string,
): Promise<{ id: string; status: string; participantType: string; guestInvitationId: string | null } | undefined> {
  const [row] = await tx
    .select({
      id: incidentParticipants.id,
      status: incidentParticipants.status,
      participantType: incidentParticipants.participantType,
      guestInvitationId: incidentParticipants.guestInvitationId,
    })
    .from(incidentParticipants)
    .where(and(eq(incidentParticipants.incidentId, incidentId), eq(incidentParticipants.id, participantId)))
    .limit(1);
  return row;
}

export async function softRemoveParticipant(tx: DbOrTx, participantId: string): Promise<void> {
  await tx
    .update(incidentParticipants)
    .set({ status: "removed", updatedAt: new Date() })
    .where(eq(incidentParticipants.id, participantId));
}

export interface ListParticipantsResult {
  items: ParticipantRow[];
  total: number;
}

export async function listParticipants(
  db: Database,
  incidentId: string,
  filter: { page: number; pageSize: number },
): Promise<ListParticipantsResult> {
  const whereClause = and(eq(incidentParticipants.incidentId, incidentId), ne(incidentParticipants.status, "removed"));

  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(incidentParticipants).where(whereClause);
  const total = countRow?.count ?? 0;

  const items = await db
    .select(PARTICIPANT_COLUMNS)
    .from(incidentParticipants)
    .leftJoin(users, eq(users.id, incidentParticipants.userId))
    .leftJoin(contacts, eq(contacts.id, incidentParticipants.contactId))
    .leftJoin(guestInvitations, eq(guestInvitations.id, incidentParticipants.guestInvitationId))
    .where(whereClause)
    .orderBy(incidentParticipants.createdAt)
    .limit(filter.pageSize)
    .offset((filter.page - 1) * filter.pageSize);

  return { items, total };
}
