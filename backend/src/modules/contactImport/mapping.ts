import { AuthError } from "../auth/errors.js";

/**
 * The ONLY destinations a source column may ever be mapped to — deliberately corresponds
 * exactly to Module 04's safe, writable Contact fields. This allowlist is also enforced at the
 * Fastify schema layer (an `enum` on the mapping request body), so a request naming any other
 * field (id, createdAt, a users/roles/groups/alerts field, …) is rejected before this code runs.
 */
export const ALLOWED_DESTINATION_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "mobilePhone",
  "department",
  "referenceId",
] as const;

export type ContactImportField = (typeof ALLOWED_DESTINATION_FIELDS)[number];

const REQUIRED_DESTINATION_FIELDS: ContactImportField[] = ["firstName", "lastName"];

/** Trims, lowercases, and strips spacing/punctuation so "First Name", "first_name", "FirstName" all compare equal. */
function normalizeHeaderKey(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/** Conservative, exact-match suggestions only — no fuzzy/AI matching. Ambiguous headers suggest nothing. */
const SUGGESTED_HEADER_KEYS: Record<string, ContactImportField> = {
  firstname: "firstName",
  fname: "firstName",
  givenname: "firstName",
  lastname: "lastName",
  lname: "lastName",
  surname: "lastName",
  email: "email",
  emailaddress: "email",
  personalemail: "email",
  workemail: "email",
  mobile: "mobilePhone",
  mobilephone: "mobilePhone",
  cell: "mobilePhone",
  cellphone: "mobilePhone",
  phone: "mobilePhone",
  phonenumber: "mobilePhone",
  department: "department",
  dept: "department",
  referenceid: "referenceId",
  employeeid: "referenceId",
  empid: "referenceId",
};

export interface MappingSuggestion {
  header: string;
  suggested: ContactImportField | null;
}

/** Suggests a destination for each header. A header with no confident, unambiguous match suggests null. */
export function suggestMapping(headers: string[]): MappingSuggestion[] {
  return headers.map((header) => ({
    header,
    suggested: SUGGESTED_HEADER_KEYS[normalizeHeaderKey(header)] ?? null,
  }));
}

export type ColumnMapping = Record<string, ContactImportField>;

/**
 * Validates an operator-submitted mapping against the batch's actual headers: every source header
 * must exist, every destination must be on the allowlist (also schema-enforced), no destination
 * may be used twice, and both required Contact fields must be mapped.
 */
export function validateMapping(mapping: ColumnMapping, headers: string[]): void {
  const headerSet = new Set(headers);
  const usedDestinations = new Set<ContactImportField>();

  for (const [header, destination] of Object.entries(mapping)) {
    if (!headerSet.has(header)) {
      throw new AuthError(400, "import_mapping_invalid", `Unknown source column: "${header}".`);
    }
    if (!ALLOWED_DESTINATION_FIELDS.includes(destination)) {
      throw new AuthError(400, "import_mapping_invalid", `"${destination}" is not a mappable Contact field.`);
    }
    if (usedDestinations.has(destination)) {
      throw new AuthError(
        400,
        "import_mapping_invalid",
        `"${destination}" is mapped from more than one column.`,
      );
    }
    usedDestinations.add(destination);
  }

  for (const required of REQUIRED_DESTINATION_FIELDS) {
    if (!usedDestinations.has(required)) {
      throw new AuthError(400, "import_mapping_invalid", `A column must be mapped to "${required}".`);
    }
  }
}
