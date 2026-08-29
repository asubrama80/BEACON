import { and, eq } from "drizzle-orm";
import { users, mfaCredentials, type Database } from "@beacon/database";
import type { AuthenticatedUser } from "./types.js";

export interface UserRecord {
  id: string;
  email: string;
  displayName: string;
  status: string;
  passwordHash: string | null;
  isBreakGlass: boolean;
  deletedAt: Date | null;
}

export async function findUserByEmail(db: Database, email: string): Promise<UserRecord | undefined> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      status: users.status,
      passwordHash: users.passwordHash,
      isBreakGlass: users.isBreakGlass,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.email, email.trim().toLowerCase()))
    .limit(1);

  return row;
}

export async function findUserById(db: Database, id: string): Promise<UserRecord | undefined> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      status: users.status,
      passwordHash: users.passwordHash,
      isBreakGlass: users.isBreakGlass,
      deletedAt: users.deletedAt,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);

  return row;
}

export function isUsableAccount(user: UserRecord): boolean {
  return user.status === "active" && user.deletedAt === null && user.passwordHash !== null;
}

export interface MfaCredentialRecord {
  id: string;
  secretCiphertext: string;
  status: string;
}

export async function findActiveMfaCredential(
  db: Database,
  userId: string,
): Promise<MfaCredentialRecord | undefined> {
  const [row] = await db
    .select({ id: mfaCredentials.id, secretCiphertext: mfaCredentials.secretCiphertext, status: mfaCredentials.status })
    .from(mfaCredentials)
    .where(and(eq(mfaCredentials.userId, userId), eq(mfaCredentials.status, "active")))
    .limit(1);

  return row;
}

export async function findPendingMfaCredential(
  db: Database,
  userId: string,
): Promise<MfaCredentialRecord | undefined> {
  const [row] = await db
    .select({ id: mfaCredentials.id, secretCiphertext: mfaCredentials.secretCiphertext, status: mfaCredentials.status })
    .from(mfaCredentials)
    .where(and(eq(mfaCredentials.userId, userId), eq(mfaCredentials.status, "pending")))
    .limit(1);

  return row;
}

export async function toAuthenticatedUser(db: Database, user: UserRecord): Promise<AuthenticatedUser> {
  const active = await findActiveMfaCredential(db, user.id);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    isBreakGlass: user.isBreakGlass,
    mfaEnabled: Boolean(active),
  };
}
