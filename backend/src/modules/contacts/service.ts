import { eq } from "drizzle-orm";
import { contacts, type Database } from "@beacon/database";
import { AuthError } from "../auth/errors.js";
import { recordAuthEvent } from "../auth/audit.js";
import { normalizeEmail, normalizePhone } from "./normalization.js";
import {
  findContactById,
  findLikelyDuplicates,
  listContacts as queryContacts,
  normalizePagination,
  type ListContactsFilter,
} from "./contactQueries.js";
import { toContactDto, type ContactDto, type DuplicateMatchDto } from "./dto.js";

const NAME_MAX_LENGTH = 128;
const DEPARTMENT_MAX_LENGTH = 128;
const REFERENCE_ID_MAX_LENGTH = 64;

async function loadDto(db: Database, id: string): Promise<ContactDto> {
  const row = await findContactById(db, id);
  if (!row) {
    throw new AuthError(404, "not_found", "Contact not found.");
  }
  return toContactDto(row);
}

function validateName(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new AuthError(400, "invalid_request", `${label} is required.`);
  }
  if (trimmed.length > NAME_MAX_LENGTH) {
    throw new AuthError(400, "invalid_request", `${label} must be ${NAME_MAX_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

/** Normalizes and validates the optional channel/metadata fields shared by create and update. */
interface NormalizedChannelFields {
  email?: string | undefined;
  mobilePhone?: string | undefined;
  department?: string | undefined;
  referenceId?: string | undefined;
}

function normalizeChannelFields(input: NormalizedChannelFields): NormalizedChannelFields {
  const result: NormalizedChannelFields = {};

  if (input.email !== undefined) {
    const trimmed = input.email.trim();
    if (trimmed) {
      const normalized = normalizeEmail(trimmed);
      if (!normalized.valid) {
        throw new AuthError(400, "invalid_request", normalized.reason ?? "Invalid email.");
      }
      result.email = normalized.value!;
    } else {
      result.email = "";
    }
  }

  if (input.mobilePhone !== undefined) {
    const trimmed = input.mobilePhone.trim();
    if (trimmed) {
      const normalized = normalizePhone(trimmed);
      if (!normalized.valid) {
        throw new AuthError(400, "invalid_request", normalized.reason ?? "Invalid phone number.");
      }
      result.mobilePhone = normalized.value!;
    } else {
      result.mobilePhone = "";
    }
  }

  if (input.department !== undefined) {
    const trimmed = input.department.trim();
    if (trimmed.length > DEPARTMENT_MAX_LENGTH) {
      throw new AuthError(400, "invalid_request", `Department must be ${DEPARTMENT_MAX_LENGTH} characters or fewer.`);
    }
    result.department = trimmed;
  }

  if (input.referenceId !== undefined) {
    const trimmed = input.referenceId.trim();
    if (trimmed.length > REFERENCE_ID_MAX_LENGTH) {
      throw new AuthError(
        400,
        "invalid_request",
        `Reference ID must be ${REFERENCE_ID_MAX_LENGTH} characters or fewer.`,
      );
    }
    result.referenceId = trimmed;
  }

  return result;
}

async function assertNoLikelyDuplicate(
  db: Database,
  values: { email?: string | undefined; mobilePhone?: string | undefined },
  excludeId: string | undefined,
  confirmDuplicate: boolean,
): Promise<void> {
  if (confirmDuplicate || (!values.email && !values.mobilePhone)) {
    return;
  }

  const candidates = await findLikelyDuplicates(db, values, excludeId);
  if (candidates.length === 0) {
    return;
  }

  const matches: DuplicateMatchDto[] = candidates.map((c) => ({
    id: c.id,
    displayName: `${c.firstName} ${c.lastName}`.trim(),
    matchedOn: c.matchedOn,
  }));

  throw new AuthError(
    409,
    "likely_duplicate",
    "This looks like an existing contact. Confirm to create it anyway.",
    { duplicates: matches },
  );
}

export interface ListContactsOptions {
  search?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface ListContactsResponse {
  items: ContactDto[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listContacts(db: Database, options: ListContactsOptions): Promise<ListContactsResponse> {
  const { page, pageSize } = normalizePagination(options.page, options.pageSize);
  const filter: ListContactsFilter = { ...options, page, pageSize };

  const result = await queryContacts(db, filter);
  return {
    items: result.items.map(toContactDto),
    total: result.total,
    page: result.page,
    pageSize: result.pageSize,
  };
}

export async function getContact(db: Database, id: string): Promise<ContactDto> {
  return loadDto(db, id);
}

export interface CreateContactInput {
  firstName: string;
  lastName: string;
  referenceId?: string;
  email?: string;
  mobilePhone?: string;
  department?: string;
  confirmDuplicate?: boolean;
}

export async function createContact(
  db: Database,
  input: CreateContactInput,
  actorId: string,
): Promise<ContactDto> {
  const firstName = validateName(input.firstName, "First name");
  const lastName = validateName(input.lastName, "Last name");
  const normalized = normalizeChannelFields(input);

  await assertNoLikelyDuplicate(
    db,
    { email: normalized.email, mobilePhone: normalized.mobilePhone },
    undefined,
    input.confirmDuplicate ?? false,
  );

  const [created] = await db
    .insert(contacts)
    .values({
      firstName,
      lastName,
      email: normalized.email || undefined,
      mobilePhone: normalized.mobilePhone || undefined,
      department: normalized.department || undefined,
      referenceId: normalized.referenceId || undefined,
    })
    .returning({ id: contacts.id });
  if (!created) {
    throw new AuthError(500, "not_found", "Contact creation failed unexpectedly.");
  }

  // Presence flags only — never the actual email/phone value — in audit metadata (PII minimization).
  await recordAuthEvent(db, {
    eventType: "CONTACT_CREATED",
    actorId,
    resourceType: "contact",
    resourceId: created.id,
    metadata: { hasEmail: Boolean(normalized.email), hasPhone: Boolean(normalized.mobilePhone) },
  });

  return loadDto(db, created.id);
}

export interface UpdateContactInput {
  firstName?: string;
  lastName?: string;
  referenceId?: string;
  email?: string;
  mobilePhone?: string;
  department?: string;
  confirmDuplicate?: boolean;
}

export async function updateContact(
  db: Database,
  id: string,
  input: UpdateContactInput,
  actorId: string,
): Promise<ContactDto> {
  const current = await findContactById(db, id);
  if (!current) {
    throw new AuthError(404, "not_found", "Contact not found.");
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  const changedFields: string[] = [];

  if (input.firstName !== undefined) {
    patch.firstName = validateName(input.firstName, "First name");
    changedFields.push("firstName");
  }
  if (input.lastName !== undefined) {
    patch.lastName = validateName(input.lastName, "Last name");
    changedFields.push("lastName");
  }

  const normalized = normalizeChannelFields({
    email: input.email,
    mobilePhone: input.mobilePhone,
    department: input.department,
    referenceId: input.referenceId,
  });

  let channelChanged = false;
  if (normalized.email !== undefined && normalized.email !== (current.email ?? "")) {
    patch.email = normalized.email || null;
    changedFields.push("email");
    channelChanged = true;
  }
  if (normalized.mobilePhone !== undefined && normalized.mobilePhone !== (current.mobilePhone ?? "")) {
    patch.mobilePhone = normalized.mobilePhone || null;
    changedFields.push("mobilePhone");
    channelChanged = true;
  }
  if (normalized.department !== undefined) {
    patch.department = normalized.department || null;
    changedFields.push("department");
  }
  if (normalized.referenceId !== undefined) {
    patch.referenceId = normalized.referenceId || null;
    changedFields.push("referenceId");
  }

  if (channelChanged) {
    await assertNoLikelyDuplicate(
      db,
      {
        email: "email" in patch ? (normalized.email as string) : (current.email ?? undefined),
        mobilePhone: "mobilePhone" in patch ? (normalized.mobilePhone as string) : (current.mobilePhone ?? undefined),
      },
      id,
      input.confirmDuplicate ?? false,
    );
  }

  if (changedFields.length > 0) {
    await db.update(contacts).set(patch).where(eq(contacts.id, id));

    await recordAuthEvent(db, {
      eventType: "CONTACT_UPDATED",
      actorId,
      resourceType: "contact",
      resourceId: id,
      metadata: { fields: changedFields },
    });
  }

  return loadDto(db, id);
}

export async function disableContact(db: Database, id: string, actorId: string): Promise<ContactDto> {
  const current = await findContactById(db, id);
  if (!current) {
    throw new AuthError(404, "not_found", "Contact not found.");
  }

  await db.update(contacts).set({ status: "inactive", updatedAt: new Date() }).where(eq(contacts.id, id));

  await recordAuthEvent(db, {
    eventType: "CONTACT_DISABLED",
    actorId,
    resourceType: "contact",
    resourceId: id,
  });

  return loadDto(db, id);
}

export async function enableContact(db: Database, id: string, actorId: string): Promise<ContactDto> {
  const current = await findContactById(db, id);
  if (!current) {
    throw new AuthError(404, "not_found", "Contact not found.");
  }

  await db.update(contacts).set({ status: "active", updatedAt: new Date() }).where(eq(contacts.id, id));

  await recordAuthEvent(db, {
    eventType: "CONTACT_ENABLED",
    actorId,
    resourceType: "contact",
    resourceId: id,
  });

  return loadDto(db, id);
}
