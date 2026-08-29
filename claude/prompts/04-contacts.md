# Module 04 — Contacts

## Scope

The BEACON contact directory: the people BEACON can reach by SMS or email who are **not** BEACON application users. Covers: extending the Module 01 `contacts` table minimally, email/phone normalization, non-blocking duplicate detection with explicit override, active/inactive lifecycle (soft-delete-preserving, never a hard delete), permission-based CRUD APIs, audit events, and the minimum frontend admin UI (list/search/filter/create/view/edit/disable/enable). CSV/Excel import (Module 05), Groups (Module 06), and alert/SMS/email sending (Module 09) are explicitly out of scope — this module's normalization/duplicate-detection service functions are designed to be reusable by Module 05, but nothing from 05+ is implemented here.

## Contacts vs. Users — the hard boundary

A Contact is a directory entry BEACON can notify; it does not require login, is never automatically a User, and never requires a `user_id`. Nothing in this module creates, modifies, or links to the `users` table, a role, a group, an alert, or any external system (no verification SMS, no mailbox check) — creating a Contact is a pure, local, single-table write plus an audit row. This works without any dependency on AD/Entra/LDAP/M365/HR/MDM/VPN, matching CLAUDE.md's portability requirement. Verified by grep (no `users` import in `contacts/service.ts`, `contacts/routes.ts`, `contacts/dto.ts`, `contacts/contactQueries.ts`) and by the live/integration tests asserting `beacon_dev`'s `users` table is untouched by any contacts operation.

## Data model

`database/src/schema/contacts.ts` (extends the existing Module 01 table — no new table):

| Column | Notes |
| --- | --- |
| `id` | unchanged |
| `referenceId` | unchanged, unique-indexed — maps to the prototype's "Employee ID" |
| `firstName`, `lastName` | unchanged |
| `email` | unchanged column, but now **always holds the normalized (trimmed, lowercased) form** — normalization happens at write time, not read time |
| `mobilePhone` | unchanged column, now always holds the **E.164-normalized** form |
| `department` | **new**, `varchar(128)`, nullable — free text, deliberately not a foreign key since no org-structure module exists yet |
| `status` | unchanged, `active`/`inactive` check constraint |
| `createdAt`, `updatedAt`, `deletedAt` | unchanged |

No unique constraint was added on `email` or `mobilePhone` — people can legitimately share a phone or email (e.g. a shared department line), so uniqueness is handled as duplicate *detection*, not a hard constraint (see below). A new index, `contacts_mobile_phone_idx`, was added since phone is now a common search/lookup key alongside the existing indexes; no other new indexes were added without a concrete read pattern justifying them.

Migration: `database/migrations/0004_sour_patch.sql` (adds `department`, adds the phone index) — applied live to `beacon_dev`.

## Normalization

`backend/src/modules/contacts/normalization.ts`, deliberately written as small, pure, reusable functions (no DB, no framework types) so Module 05's bulk import can call the same logic later:

- **Email** — trim, lowercase, validate against a permissive-but-real pattern (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`), 255-char max. No external mailbox/MX verification — that's a network dependency this module doesn't need.
- **Phone** — parsed with `libphonenumber-js` (`parsePhoneNumberWithError`, default region `"US"`), stored as E.164 (`+1XXXXXXXXXX` for US numbers) when valid. Purely offline — no external validation service. International numbers are not precluded: any number the library can parse and validate as a real number succeeds, not just US ones.
- Invalid input produces a specific, useful rejection reason (not a silent coercion) — surfaced as a 400 from the create/update routes.
- **Gotcha discovered during testing:** `libphonenumber-js` treats US "555" exchange numbers (e.g. `555-123-4567`) as fictional/reserved and rejects them as invalid, even though they look like normal US numbers. All test/fixture phone numbers in this module use realistic non-555 numbers.

## Duplicate detection

Not a unique constraint — an explicit, non-blocking check surfaced to the caller:

- On create, and on update *only when* email or phone actually changed, `findLikelyDuplicates()` looks for other active-or-inactive contacts with an exact match on the normalized email or normalized phone (excluding the record being updated).
- If matches exist and the caller didn't pass `confirmDuplicate: true`, the request is rejected with **409 `likely_duplicate`**, plus a `duplicates` array (`{ id, displayName, matchedOn }` — no email/phone values, just which field matched) so the caller can show a human the ambiguity.
- Passing `confirmDuplicate: true` proceeds and creates/updates a genuinely separate row — duplicates are never silently merged. Verified live: two contacts sharing the same email coexist with no constraint violation.

## Lifecycle

Soft-delete-preserving: there is no hard-delete endpoint. `disable`/`enable` toggle `status` between `active`/`inactive`; a disabled contact remains fully retrievable by id, by search, and via the `status=inactive` list filter — nothing about its history or relationships is destroyed. `GET /contacts` defaults to no status filter (both), so operators don't lose visibility into inactive contacts by default unless they filter it away.

## Permission mapping

Extends Module 03's `requirePermission()` RBAC framework — no hard-coded role-name checks anywhere in this module (verified by grep). Four new permission codes seeded via `MODULE_04_PERMISSIONS` in `database/src/permissionCodes.ts`:

| Code | Grants |
| --- | --- |
| `contacts.read` | List/view contacts |
| `contacts.create` | Create a contact |
| `contacts.update` | Edit a contact's details |
| `contacts.disable` | Disable or re-enable a contact |

Role grants (`database/src/seed.ts`), with rationale:

- **ADMIN** — all four (full contact administration, consistent with its full Module 03 grant).
- **COMMUNICATION_MANAGER** — `contacts.read`, `contacts.create`, `contacts.update`. This role's job is composing and sending communications, which requires maintaining who's reachable — but disabling/retiring a contact is treated as a more consequential lifecycle action, deliberately withheld pending a clearer operational need.
- **AUDITOR** — `contacts.read` only, consistent with its existing "read-only access for compliance and audit review" description — justified the same way its Module 03 `users.read`/`roles.read`/`permissions.read` grants are.
- **INCIDENT_COMMANDER** — `contacts.read` only. Justified narrowly: during incident response an IC needs visibility into who can be reached, but has no standing need to create/edit/disable the directory itself. Not granted create/update/disable, since nothing in the role's current responsibilities calls for it.
- **RESPONDER** — none. Nothing in a responder's current job justifies contact-directory access; not invented to fill the role.

Seed is idempotent — live-verified via two consecutive `db:seed` runs: 11 permissions total (7 Module 03 + 4 Module 04), 19 role-permission mappings (ADMIN 11, AUDITOR 4, INCIDENT_COMMANDER 1, COMMUNICATION_MANAGER 3, RESPONDER 0), unchanged on the second run.

## API summary

All routes require a valid session (`authenticate`) plus the named permission; all mutating routes additionally require the CSRF header (Module 02's double-submit cookie). Malformed UUIDs in `:id` are rejected with 400 by Fastify schema validation before the handler runs.

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/contacts` | `contacts.read` — paginated (default 25, max 100), searchable (name/email/phone via `ilike`), status-filterable |
| GET | `/contacts/:id` | `contacts.read` |
| POST | `/contacts` | `contacts.create` — `confirmDuplicate?: boolean` to override a 409 |
| PATCH | `/contacts/:id` | `contacts.update` — explicit allowlist only, never a raw spread |
| POST | `/contacts/:id/disable` | `contacts.disable` |
| POST | `/contacts/:id/enable` | `contacts.disable` |

No hard-delete endpoint exists by design.

## Privacy and security decisions

- `contacts.read` is required for any contact detail — there is no unauthenticated or partial-detail path.
- Generic errors (400/404) never echo submitted contact data back — validation failures reference field names/reasons, not the invalid value itself.
- No contacts route or service function ever `console.log`s a contact payload.
- Audit metadata never contains raw email/phone values — only booleans (`hasEmail`, `hasPhone` on create) or the *names* of changed fields (`fields: ["department"]` on update), never the values. Verified live: `JSON.stringify` of all 10 audit rows produced during live validation contained zero raw contact PII.
- No field-level encryption was added — this module doesn't introduce a new class of sensitive data beyond what Module 01's schema already stored in plain columns, and nothing in the spec required it.
- Response DTOs (`dto.ts`) are built from an explicit safe-column select (`SAFE_CONTACT_COLUMNS`) — there is no raw DB row anywhere that could accidentally leak an unrelated column, and no User/auth field ever appears on a Contact response (verified by a secret/auth-field pattern scan of API responses in tests).

## Audit events

`CONTACT_CREATED`, `CONTACT_UPDATED`, `CONTACT_DISABLED`, `CONTACT_ENABLED` — added to Module 02/03's `AuthAuditEventType` union, recorded via the same shared `recordAuthEvent()` helper with `actorId`, `resourceType: "contact"`, `resourceId`, and safe metadata only (see Privacy above). No audit event ever logs a request body.

## Mass-assignment defense

Same two-layer pattern established in Module 03: `createContactBodySchema`/`updateContactBodySchema` set `additionalProperties: false` (Fastify's AJV silently strips unrecognized fields rather than 400ing — confirmed empirically, consistent with Module 03), and independently, `service.ts` never spreads the raw request body — every write reads named, allowlisted fields explicitly. Verified live and in tests: a forged `status`/`id` field in a create/update payload has no effect.

## Reusable-for-Module-05 service boundary

`normalization.ts` (`normalizeEmail`, `normalizePhone`) and the duplicate-detection query (`findLikelyDuplicates` in `contactQueries.ts`) are deliberately framework-agnostic pure functions/query helpers with no route- or request-specific coupling, so a future bulk-import module can call them directly per row without re-implementing normalization or duplicate logic. Nothing from Module 05 (file parsing, import job orchestration, bulk endpoints) was implemented in this module.

## Frontend

`frontend/src/contacts/` — `ContactsPage` (list, search, active/inactive filter, pagination footer, permission-gated "Add Contact" button), `CreateContactModal`, `ContactDetailModal` (view/edit/disable/enable, permission-gated field editability), matching the stakeholder prototype's structure and visual system. `Modal` and shared admin-screen CSS (`adminUi.css`) were extracted from the Users module into `frontend/src/components/` during this work so Contacts and Users share one implementation instead of duplicating it — re-verified the Users screens still pass lint/typecheck/tests after the move.

Deliberately omitted from the create/edit form relative to the prototype's "Add Contact" modal: a second "work email" field (the schema has one `email` column), "Location" (not in the module's required minimum field set), and "Groups" (explicitly Module 06, out of scope). All other fields (First/Last name, Employee/Reference ID, Mobile, Email, Department) match the prototype.

Frontend permission checks (`user.permissions.includes(...)`) gate visibility/UX only — every action still calls the real API, which independently authorizes server-side; the backend remains authoritative.

## Security review performed

- Grepped `contacts/*.ts` for role-name checks (`role.code ===`, `role ===`) — none found.
- Confirmed all 6 contacts routes chain `authenticate` + `requirePermission`, and all 4 mutating routes call `requireCsrf` (verified by count: 6 routes, 6 permission guards, 4 CSRF calls).
- Confirmed no `users` table reference anywhere in the contacts module (Contacts/Users boundary).
- Verified mass-assignment has no effect, live and in tests.
- All queries use Drizzle's parameterized query builder (including the `ilike` search) — no string-concatenated SQL.
- Verified no contact PII in audit metadata (live `JSON.stringify` scan of all CONTACT_* rows) and no auth-secret fields in any contact API response (test scan for `passwordHash|argon2|mfa|sessionToken|recoveryCode`).
- Verified role grants are not "invented to fill the role" — each grant above is tied to a stated operational justification; RESPONDER received none.
- Verified no hard-delete path exists and disabled contacts remain fully retrievable (history/relationships preserved).
- Verified duplicate detection never silently merges — a confirmed duplicate creates a genuinely separate row, live.
- Verified normalization correctness via unit tests (11 cases) plus live create with deliberately unnormalized input.
- Confirmed no secrets in any file touched this module (`.env` untouched, not staged).
- Confirmed this module implements nothing from Module 05 (no CSV/Excel parsing or import endpoints), Module 06 (no groups), or Module 09 (no send/notify logic) — grepped for accidental scope creep.

## Acceptance criteria

- [x] A. A Contact never requires login and is never automatically a User.
- [x] B. No Contact operation ever creates, modifies, or requires a `user_id` / User row — verified by grep and live testing.
- [x] C. Works without any AD/Entra/LDAP/M365/HR/MDM/VPN dependency — no such integration exists in this module.
- [x] D. The existing `contacts` table is extended, not replaced — one new migration (`0004_sour_patch.sql`).
- [x] E. Email is normalized (trim/lowercase) and validated without external verification.
- [x] F. Phone is normalized toward E.164, correct for US, without precluding international numbers, without an external validation service.
- [x] G. Invalid email/phone is rejected with a useful error, not silently coerced.
- [x] H. No unique constraint blocks legitimately shared email/phone.
- [x] I. Duplicate detection warns/conflicts explicitly and never silently merges — live-verified (409 + confirmed-create-anyway produces a separate row).
- [x] J. Contacts have an active/inactive lifecycle; no hard delete exists.
- [x] K. Disabled contacts remain retrievable by id and via the inactive filter — live-verified.
- [x] L. All six specified REST endpoints exist, permission-protected, following REST conventions.
- [x] M. `GET /contacts` supports pagination, search, and active/inactive filtering — live-verified.
- [x] N. Responses use an explicit Contact DTO — no DB internals or User/auth fields leak (test-verified scan).
- [x] O. Create never creates a user/role/group/alert/verification SMS/external contact — verified by grep and live testing.
- [x] P. Update uses an explicit field allowlist, never a raw spread, and re-runs validation/duplicate-detection when channel fields change.
- [x] Q. Disable/enable are explicit, audited lifecycle actions that never destroy relationships.
- [x] R. RBAC is extended with `contacts.read/create/update/disable`, permission-based (no hard-coded role checks) — verified by grep.
- [x] S. Role grants match the documented, justified mapping above (not invented to fill a role) — RESPONDER received none.
- [x] T. Permission seed is idempotent — live-verified (two `db:seed` runs, unchanged counts).
- [x] U. `contacts.read` is required for any contact detail; no unauthenticated access; no PII in generic errors/logs/audit metadata beyond safe flags/field names — live-verified.
- [x] V. All four audit events exist, correctly attributed, PII-free — live-verified.
- [x] W. Frontend implements nav/list/search/filter/pagination/create/view/edit/disable/enable/duplicate-warning/validation messaging, matching the prototype's structure without redesigning it.
- [x] X. Frontend explicitly does not implement CSV/Excel import, Groups, Templates, Alerts, bulk notification, or incident participation.
- [x] Y. Frontend permission checks are UX-only; the backend remains authoritative.
- [x] Z. No Module 05/06/09 functionality was implemented — verified by review.
- [x] AA. Field-length validation and malformed-UUID rejection produce consistent error responses — live and test-verified.
- [x] AB. New DB indexes are justified, not blind (`contacts_mobile_phone_idx` — phone is now a common lookup/search key).
- [x] AC. Lint, typecheck, tests, and build all pass — see Validation below.

## Validation performed

- `npm install` (added `libphonenumber-js`), `npm run db:generate` / `db:migrate` (migration `0004_sour_patch.sql` applied to `beacon_dev`), `npm run db:seed` run twice (idempotent — unchanged: 11 permissions, 19 role-permission mappings).
- `npm run lint`, `npm run typecheck`, `npm run build` — clean across `frontend`, `backend`, `database`.
- `npm run test` — 151 tests total: frontend 14 (existing Users/App suites + new `ContactsPage.test.tsx` list/create/duplicate-warning, plus an `App.test.tsx` case for Contacts-nav visibility), backend 125 (existing Module 01–03 suites, updated for Module 04's legitimate AUDITOR/ADMIN permission-set expansion, plus new `contacts/normalization.test.ts` (11 unit tests) and `contacts/routes.integration.test.ts` (~21 live-DB integration tests covering RBAC, CRUD, normalization, duplicate detection, mass-assignment, search/filter, lifecycle, and audit PII-safety)), database 12.
- **Live validation against `beacon_dev`** (native PostgreSQL 18, `DATABASE_URL` never displayed): created three throwaway actor accounts (ADMIN, COMMUNICATION_MANAGER, RESPONDER) directly via the auth module's own password/config code, started the real backend, and ran the full `curl`-driven flow as the ADMIN: create (with deliberately unnormalized input) → verified normalization → retrieved by id → searched by name and by email → updated a field → triggered duplicate detection (409, then confirmed-create-anyway producing a genuinely separate row) → disabled → verified the active/inactive filters and that the disabled contact remained GET-able → re-enabled. Then verified COMMUNICATION_MANAGER can create/update but is correctly blocked (403) from disabling. Then verified RESPONDER is blocked (403) from both listing and creating, and that an unauthenticated request gets 401. Inspected all 10 CONTACT_* audit rows directly and confirmed zero raw PII in metadata. Repeated the core flow (login → Contacts list → Add Contact → duplicate-warning banner → "Create anyway" → open detail → disable → re-enable) through the **actual React frontend in a real browser**, confirming the UI matched the API state at every step. All live-validation users, contacts, and audit rows were removed afterward — `beacon_dev` confirmed back to its pre-validation seed-only state.

## Known limitations / follow-up

- As in Modules 02/03, this session's live-validation actor accounts were created via a temporary, non-interactive script rather than `bootstrap-user.ts`'s interactive prompts, due to the same Windows/Node 24 `readline/promises` automation limitation documented in those modules' write-ups. Not a limitation of the Contacts module itself.
- `department` is a free-text column with no organizational-structure module behind it yet; if/when an org-structure module exists, this could become a foreign key.
- Duplicate detection is exact-match only on normalized email/phone — no fuzzy name-matching. Reasonable for this module's scope; a future enhancement if false negatives become a real problem.
