/** Explicit response shape — never a raw DB row spread directly into a response. */
export interface ContactDto {
  id: string;
  referenceId: string | null;
  firstName: string;
  lastName: string;
  displayName: string;
  email: string | null;
  mobilePhone: string | null;
  department: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ContactRow {
  id: string;
  referenceId: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  mobilePhone: string | null;
  department: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

export function toContactDto(contact: ContactRow): ContactDto {
  return {
    id: contact.id,
    referenceId: contact.referenceId,
    firstName: contact.firstName,
    lastName: contact.lastName,
    displayName: `${contact.firstName} ${contact.lastName}`.trim(),
    email: contact.email,
    mobilePhone: contact.mobilePhone,
    department: contact.department,
    status: contact.status,
    createdAt: contact.createdAt.toISOString(),
    updatedAt: contact.updatedAt.toISOString(),
  };
}

/** A likely-duplicate match surfaced to the operator — never enough detail to itself leak full PII unnecessarily. */
export interface DuplicateMatchDto {
  id: string;
  displayName: string;
  matchedOn: ("email" | "mobilePhone")[];
}
