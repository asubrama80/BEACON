import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { guestInvitations, incidents, users, type Database, type DbOrTx } from "@beacon/database";
import type { GuestInvitationRow } from "./guestInvitationDto.js";

const invitedByUsers = alias(users, "invited_by_users");
const revokedByUsers = alias(users, "revoked_by_users");

const ROW_COLUMNS = {
  id: guestInvitations.id,
  incidentId: guestInvitations.incidentId,
  guestName: guestInvitations.guestName,
  email: guestInvitations.email,
  mobilePhone: guestInvitations.mobilePhone,
  status: guestInvitations.status,
  permissions: guestInvitations.permissions,
  expiresAt: guestInvitations.expiresAt,
  verifiedAt: guestInvitations.verifiedAt,
  joinedAt: guestInvitations.joinedAt,
  revokedAt: guestInvitations.revokedAt,
  revokedByDisplayName: revokedByUsers.displayName,
  invitedByDisplayName: invitedByUsers.displayName,
  createdAt: guestInvitations.createdAt,
} as const;

export interface InsertInvitationInput {
  incidentId: string;
  guestName: string;
  email: string | null;
  mobilePhone: string | null;
  tokenHash: string;
  capabilities: { chat: boolean; warRoom: boolean };
  expiresAt: Date;
  invitedBy: string;
}

export async function insertInvitation(db: DbOrTx, input: InsertInvitationInput): Promise<{ id: string }> {
  const [row] = await db
    .insert(guestInvitations)
    .values({
      incidentId: input.incidentId,
      guestName: input.guestName,
      email: input.email,
      mobilePhone: input.mobilePhone,
      status: "pending",
      tokenHash: input.tokenHash,
      permissions: input.capabilities,
      expiresAt: input.expiresAt,
      invitedBy: input.invitedBy,
    })
    .returning({ id: guestInvitations.id });
  if (!row) throw new Error("Failed to create guest invitation.");
  return row;
}

export async function markInvitationSent(db: DbOrTx, id: string): Promise<void> {
  await db.update(guestInvitations).set({ status: "sent", updatedAt: new Date() }).where(eq(guestInvitations.id, id));
}

export async function findInvitationRow(db: Database, incidentId: string, invitationId: string): Promise<GuestInvitationRow | undefined> {
  const [row] = await db
    .select(ROW_COLUMNS)
    .from(guestInvitations)
    .leftJoin(invitedByUsers, eq(invitedByUsers.id, guestInvitations.invitedBy))
    .leftJoin(revokedByUsers, eq(revokedByUsers.id, guestInvitations.revokedByUserId))
    .where(and(eq(guestInvitations.id, invitationId), eq(guestInvitations.incidentId, incidentId)))
    .limit(1);
  return row;
}

export async function listInvitationsForIncident(db: Database, incidentId: string): Promise<GuestInvitationRow[]> {
  return db
    .select(ROW_COLUMNS)
    .from(guestInvitations)
    .leftJoin(invitedByUsers, eq(invitedByUsers.id, guestInvitations.invitedBy))
    .leftJoin(revokedByUsers, eq(revokedByUsers.id, guestInvitations.revokedByUserId))
    .where(eq(guestInvitations.incidentId, incidentId))
    .orderBy(desc(guestInvitations.createdAt));
}

const ACTIVE_STATUSES = ["pending", "sent"] as const;

/**
 * An "active" invitation for duplicate detection: not yet verified/joined (those are a real,
 * successful outcome, not a duplicate to collapse), not expired, not revoked. See
 * claude/prompts/17-guest-invitations.md, "Duplicate invitations".
 */
export async function findActiveInvitation(
  db: DbOrTx,
  incidentId: string,
  destination: { email: string | null; mobilePhone: string | null },
): Promise<{ id: string } | undefined> {
  const destinationMatch = or(
    destination.email ? eq(guestInvitations.email, destination.email) : undefined,
    destination.mobilePhone ? eq(guestInvitations.mobilePhone, destination.mobilePhone) : undefined,
  );
  if (!destinationMatch) return undefined;

  const [row] = await db
    .select({ id: guestInvitations.id })
    .from(guestInvitations)
    .where(
      and(
        eq(guestInvitations.incidentId, incidentId),
        destinationMatch,
        or(...ACTIVE_STATUSES.map((s) => eq(guestInvitations.status, s))),
        gt(guestInvitations.expiresAt, new Date()),
        isNull(guestInvitations.revokedAt),
      ),
    )
    .limit(1);
  return row;
}

/** Conditional UPDATE — never revokes an already-revoked invitation twice, never revokes past history. */
export async function revokeInvitationRow(db: DbOrTx, id: string, actorId: string): Promise<boolean> {
  const result = await db
    .update(guestInvitations)
    .set({ status: "revoked", revokedAt: new Date(), revokedByUserId: actorId, updatedAt: new Date() })
    .where(and(eq(guestInvitations.id, id), isNull(guestInvitations.revokedAt)))
    .returning({ id: guestInvitations.id });
  return result.length > 0;
}

export interface PublicLookupRow {
  id: string;
  incidentId: string;
  incidentNumber: string;
  incidentTitle: string;
  incidentStatus: string;
  guestName: string;
  email: string | null;
  mobilePhone: string | null;
  status: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** Unscoped by design — the token hash itself is the only lookup key a public caller can supply. */
export async function findPublicInvitationByTokenHash(db: Database, tokenHash: string): Promise<PublicLookupRow | undefined> {
  const [row] = await db
    .select({
      id: guestInvitations.id,
      incidentId: guestInvitations.incidentId,
      incidentNumber: incidents.incidentNumber,
      incidentTitle: incidents.title,
      incidentStatus: incidents.status,
      guestName: guestInvitations.guestName,
      email: guestInvitations.email,
      mobilePhone: guestInvitations.mobilePhone,
      status: guestInvitations.status,
      expiresAt: guestInvitations.expiresAt,
      revokedAt: guestInvitations.revokedAt,
    })
    .from(guestInvitations)
    .innerJoin(incidents, eq(incidents.id, guestInvitations.incidentId))
    .where(eq(guestInvitations.tokenHash, tokenHash))
    .limit(1);
  return row;
}

/**
 * Conditional UPDATE — WHERE status NOT IN ('verified','joined') makes this idempotent-safe under
 * a concurrent double-verify (see claude/prompts/18-otp-verification.md, "Concurrent verification"):
 * the first caller to land here wins and does the one-time verified-state side effects; a losing
 * concurrent caller's update simply affects 0 rows, which is not an error.
 */
export async function markInvitationVerified(db: DbOrTx, id: string): Promise<boolean> {
  const result = await db
    .update(guestInvitations)
    .set({ status: "verified", verifiedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(guestInvitations.id, id), sql`${guestInvitations.status} NOT IN ('verified', 'joined')`))
    .returning({ id: guestInvitations.id });
  return result.length > 0;
}

export interface InvitationAuthContextRow {
  id: string;
  incidentId: string;
  guestName: string;
  status: string;
  permissions: unknown;
  expiresAt: Date;
  revokedAt: Date | null;
  incidentStatus: string;
}

/**
 * The full context Module 18 (issuing a session) and Module 19 (`authenticateGuest()`) need —
 * distinct from `PublicLookupRow` because it also carries `permissions` (capabilities), which the
 * public pre-verification landing page must never see for an *unverified* invitation's own
 * safety reasoning, but which an authenticated Guest's own session context legitimately needs.
 */
export async function findInvitationAuthContext(db: DbOrTx, invitationId: string): Promise<InvitationAuthContextRow | undefined> {
  const [row] = await db
    .select({
      id: guestInvitations.id,
      incidentId: guestInvitations.incidentId,
      guestName: guestInvitations.guestName,
      status: guestInvitations.status,
      permissions: guestInvitations.permissions,
      expiresAt: guestInvitations.expiresAt,
      revokedAt: guestInvitations.revokedAt,
      incidentStatus: incidents.status,
    })
    .from(guestInvitations)
    .innerJoin(incidents, eq(incidents.id, guestInvitations.incidentId))
    .where(eq(guestInvitations.id, invitationId))
    .limit(1);
  return row;
}
