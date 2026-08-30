# Module 06 — Groups

## Scope

Static, reusable Contact Groups: create/edit/disable/enable a Group, and manage its membership (add one or many existing Contacts, remove one, list them). A Group is a named collection of Contacts, nothing more — it does not send anything, does not create Incidents or Incident Participants, and is not itself a target of any alert yet (that's Module 09's job). Groups, Templates (07), Incidents (08), and Alerts (09) remain untouched beyond this module's own boundary.

## Architecture: User vs. Contact vs. Group

Unchanged, extended by one more concept:

- **User** — can log into BEACON. Never touched by this module (no `users` import anywhere in `backend/src/modules/groups/`, grep-verified).
- **Contact** — can receive notifications (Module 04). Groups reference Contacts, never Users.
- **Group** — a reusable, named set of Contacts. A Group does not require Users, does not create Contacts, does not send anything, and does not create Incident Participants.

Membership is strictly **Contact → Group**, one level, no exceptions:

- **No nested Groups.** A Group cannot contain another Group — `group_members.contact_id` is a foreign key into `contacts` only; there is no `child_group_id` concept anywhere in the schema or API. This avoids recursion, cycles, and ambiguous future alert-recipient expansion.
- **No dynamic Groups.** Membership is a static, explicit list of rows in `group_members` — no rule-based/filter-based membership, no "all Contacts in department X," no LDAP/Entra/HR-backed group sync, no scheduled membership evaluation. If dynamic groups are ever needed, that's a distinct future module, not an extension bolted onto this one.

## Data model

Reused, not replaced, from Module 01's schema, with one targeted correction to `groups`:

- **`groups`** (unchanged columns: `id`, `name`, `description`, `status`, `createdAt`, `updatedAt`, `deletedAt`) — the one schema change is to the uniqueness index on `name` (see below). `deletedAt` remains present but unused/vestigial, exactly like Module 04's `contacts.deletedAt` — lifecycle is soft-disable via `status`, never hard-delete.
- **`group_members`** (unchanged: `id`, `groupId` → `groups.id` cascade, `contactId` → `contacts.id` cascade, `createdAt`) — already had a composite unique index (`groupId`, `contactId`) and an index on `groupId` from Module 01; both were sufficient as-is.

Migration `0006_first_mac_gargan.sql`:
```sql
DROP INDEX "groups_name_idx";
CREATE UNIQUE INDEX "groups_name_lower_unique_idx" ON "groups" USING btree (lower("name")) WHERE "groups"."deleted_at" IS NULL;
CREATE INDEX "groups_status_idx" ON "groups" USING btree ("status");
ALTER TABLE "groups" ADD CONSTRAINT "groups_status_check" CHECK ("groups"."status" IN ('active', 'inactive'));
```

## Group-name rules

- Trimmed; blank names rejected; capped at 255 characters (matching the column).
- **Uniqueness is case-insensitive** — "IT Operations" and "it operations" collide, per the module spec's own example — implemented as a Postgres partial unique index on `lower(name)` scoped to `deleted_at IS NULL`, not just an application-level check, so it holds even under a race between two concurrent creates. The raw `name` column still stores the operator's original display casing (the index is on `lower(name)`, not a normalized/lowercased column) — a group created as "IT Operations" always displays as "IT Operations".
- **Scope of uniqueness: disabling a Group does not free its name.** The partial index only excludes `deleted_at IS NULL` rows from the constraint — since this module never sets `deleted_at` (no hard-delete path exists), uniqueness is effectively enforced across every Group that has ever existed, active or inactive. This was a deliberate choice over letting a disabled Group's name become reusable: reusing a name while the original (disabled) Group still exists would create two operationally-identical-looking Groups with the same display name, one hidden — worse for an operator than just picking a different name for the new one.
- The service layer pre-checks name availability (case-insensitively, excluding the record being updated) before insert/update and returns a clean `409 duplicate_group_name` — the database index is the race-safety backstop, same belt-and-suspenders pattern Module 02 already uses for `users.email`.

## Lifecycle

`active` / `inactive` via `status`, exactly Module 04's Contact pattern: disable preserves the Group row and every membership row untouched; it only changes what a future "active target" list would show. Enable restores it. There is no delete endpoint. Every disable/enable is audited (`GROUP_DISABLED`/`GROUP_ENABLED`).

## Membership model

- **Add**: `POST /groups/:id/members` with `{ contactIds: string[] }` — bulk by design. Each id in the request is independently classified into exactly one of three buckets: `added` (a new membership row was created), `alreadyMember` (it already was a member — a no-op, not an error), or `notFound` (no such Contact exists — reported back, doesn't fail the rest of the request). Repeating an identical add is therefore always safe and idempotent: the second call returns the same ids under `alreadyMember` and creates nothing new. The database's composite unique index (`groupId`, `contactId`) plus `onConflictDoNothing` is the actual race-safety guarantee; the pre-check that produces the three buckets is for a clear, predictable response, not the only thing preventing a duplicate row.
- **Remove**: `DELETE /groups/:id/members/:contactId` — one membership at a time, returns `204`. Never touches the Contact row itself (not deleted, not disabled) and never affects that Contact's membership in any other Group.
- **A Contact can belong to any number of Groups simultaneously** — `group_members` has no constraint limiting a Contact to one Group, and this was verified live and in tests.
- **Never creates a Contact.** Adding a member only ever references an existing `contacts.id`; there is no "create Contact inline while adding to a Group" path, matching the module's explicit exclusion of Module 05's import concerns.

## Inactive Contacts remain historical members

An inactive (disabled) Contact is **never** automatically removed from a Group it already belongs to, and a Contact can still be **added** to a Group while inactive if an operator explicitly does so (the add-member API itself doesn't check Contact status — only the Contacts-search-to-add UI defaults its own lookup to `status=active` as a sensible UX default, not a backend restriction). This preserves directory/history context and avoids a membership list silently shrinking out from under an operator whenever someone disables a Contact for unrelated reasons. Every membership response reports the member Contact's own `contactStatus` explicitly (`active`/`inactive`) so this is never hidden — verified live: disabling Contact B after it was added to a Group left it in the member list with `contactStatus: "inactive"`, and the Group's `memberCount` stayed the same while `activeMemberCount` dropped by one.

**This module deliberately does not decide** whether a future Alert's recipient resolution should include or exclude inactive Contacts — the spec is explicit that "future Alert resolution should exclude inactive Contacts by default unless explicitly designed otherwise in Module 09," and that's Module 09's decision to make, informed by `activeMemberCount` and `getGroupMemberContactIds()` (below), not something baked into this module's membership storage.

## Member counts

Every Group response carries **both**:
- `memberCount` — every membership row, regardless of the member Contact's status.
- `activeMemberCount` — memberships whose Contact is currently `active`.

Computed with a single aggregated query per page (`LEFT JOIN group_members LEFT JOIN contacts ... GROUP BY groups.id`, using `count(...) filter (where contacts.status = 'active')` for the active count) — one query for an entire page of Groups, not one count query per Group, avoiding N+1.

## Permissions

New codes (`MODULE_06_PERMISSIONS` in `database/src/permissionCodes.ts`): `groups.read`, `groups.create`, `groups.update`, `groups.disable`, `groups.members.manage`. Grants, matching the spec's recommendation exactly:

| Role | Grant | Why |
| --- | --- | --- |
| ADMIN | all five | Full administrative access, consistent with every other permission. |
| COMMUNICATION_MANAGER | all five | Groups are exactly this role's tool — building and maintaining the distribution lists it will later target with alerts. |
| AUDITOR | `groups.read` only | Read-only role; Group management is a write action. |
| INCIDENT_COMMANDER | `groups.read` only | Visibility into response distribution lists during incident response is a real, already-justified need (same reasoning as this role's Module 04 `contacts.read` grant) — not invented to fill the role. No create/update/disable/manage-members access. |
| RESPONDER | none | No standing need for Group administration. |

Seed is idempotent — live-verified (two `db:seed` runs, unchanged: 17 permissions, 33 role-permission mappings).

## Contact-read dependency (the "hidden route" risk)

The module spec explicitly flags this as something to review: Group *member list* responses embed real Contact fields (name, email, mobile phone) — that's PII a `groups.read`-only user shouldn't automatically see just because they can see Groups exist. The resolution, implemented and documented deliberately rather than left implicit:

- **`GET /groups`, `GET /groups/:id`** return only Group-level data (name, description, status, counts) — no Contact PII — so `groups.read` alone is sufficient.
- **`GET /groups/:id/members`** returns full member Contact fields, so it requires **both** `groups.read` **and** `contacts.read` (two chained `requirePermission` preHandlers) — never just one. In the current seed every role holding `groups.read` also holds `contacts.read`, so this doesn't change today's effective access, but it's the correct, defensible rule rather than an accident of the current role table, and it protects against a future role that's granted `groups.read` without `contacts.read`.
- **The "search Contacts to add as members" UI action reuses the existing `GET /contacts?search=...` endpoint directly** (already gated on `contacts.read`) — there is no second, Groups-scoped contact-search route. This was a deliberate choice to avoid exactly the "hidden route that bypasses Contact privacy controls" risk the spec calls out.
- **`POST /groups/:id/members` and `DELETE /groups/:id/members/:contactId`** are gated on `groups.members.manage` alone and return no Contact PII in their responses (just ids/counts/booleans) — so they don't need the dual gate.

## API summary

All routes require a valid session (`authenticate`) plus the named permission(s); the six mutating routes additionally require the CSRF header.

| Method | Path | Permission(s) |
| --- | --- | --- |
| GET | `/groups` | `groups.read` — paginated, searchable by name, active/inactive filterable |
| GET | `/groups/:id` | `groups.read` |
| POST | `/groups` | `groups.create` |
| PATCH | `/groups/:id` | `groups.update` — allowlist: `name`, `description` |
| POST | `/groups/:id/disable` | `groups.disable` |
| POST | `/groups/:id/enable` | `groups.disable` |
| GET | `/groups/:id/members` | `groups.read` **and** `contacts.read` — paginated, searchable |
| POST | `/groups/:id/members` | `groups.members.manage` — `{ contactIds: string[] }`, up to 500 per request |
| DELETE | `/groups/:id/members/:contactId` | `groups.members.manage` |

## Reusable service boundary for Module 09

`getGroupMemberContactIds(db, groupId): Promise<string[]>` (in `backend/src/modules/groups/groupQueries.ts`) returns a Group's raw member Contact ids with no filtering — a small, generic, already-tested query function a future Alert-recipient-resolution service can call directly instead of re-deriving membership logic. Nothing about *how* those ids get used (active-only filtering, deduplication across multiple targeted Groups, etc.) is decided here — that's Module 09's resolution logic to build.

## Frontend

`frontend/src/groups/` — a card-grid `GroupsPage` (matching the stakeholder prototype's `.group-card-grid`/`.group-tile` visual language, adapted into `GroupsPage.css` importing the shared `adminUi.css`) with search/status-filter/pagination-footer, a permission-gated "Create Group" button, and per-tile "View / Edit" and "Members" actions. `CreateGroupModal` (name + description). `GroupDetailModal` (edit name/description, disable/enable, a "Manage Members" shortcut). `GroupMembersModal` — the member-management surface: a Contact search box (calling the real `/contacts` API, defaulting to active Contacts, with multi-select checkboxes and an "Add Selected (N)" button), and a searchable current-members table showing each member's own active/inactive badge and a "Remove" action. Reachable via its own top-level "Groups" nav item (permission-gated on `groups.read`), alongside Contacts and Users. Frontend permission checks (`groups.create`/`groups.update`/`groups.disable`/`groups.members.manage`) gate visibility/UX only; the backend independently authorizes every action.

## Audit

`GROUP_CREATED`, `GROUP_UPDATED`, `GROUP_DISABLED`, `GROUP_ENABLED`, `GROUP_MEMBER_ADDED`, `GROUP_MEMBER_REMOVED` — same shared `recordAuthEvent()` helper as every prior module. Metadata is deliberately minimal: `GROUP_CREATED` logs the Group's `name` (operational metadata, not Contact PII); `GROUP_UPDATED` logs which fields changed (names only); `GROUP_MEMBER_ADDED`/`REMOVED` log Contact **ids** only (opaque UUIDs — never a name, email, or phone number, matching the spec's "avoid unnecessary Contact PII in audit metadata" instruction precisely). Verified live: a full create→update→add→remove→disable→enable sequence produced audit rows containing zero occurrences of the test Contact's actual name.

## Security review performed

- Grepped the whole `groups` module for any `users` schema import — none found, confirming Users are structurally impossible to reference as Group members.
- Grepped for role-name checks (`role.code ===`, `role ===`) — none found.
- Confirmed all 9 routes chain `authenticate` + the correct permission(s) (10 permission-guard applications across 9 routes, since the member-list route requires two), and exactly the 6 mutating routes call `requireCsrf`.
- Confirmed the module's one raw `sql` template (the case-insensitive name-lookup condition) interpolates the search value as a genuine bound parameter, not string concatenation — Drizzle's `sql` tag parameterizes any non-column JS value automatically; verified by design and by the passing case-insensitive-duplicate test.
- Verified live and in tests: mass-assignment on update is a no-op (forged `status`/`id` fields ignored); duplicate membership is DB-protected and returns a predictable, non-error result; a nonexistent Contact id in a bulk add is reported back rather than failing the request; removing a membership never touches the Contact row; a Contact can belong to multiple Groups; an inactive Contact is never silently dropped from a Group.
- Verified no auth-secret fields ever appear in a Group or member response (test scan for `passwordHash|argon2|mfa|sessionToken|recoveryCode`).
- Confirmed by design and by review: no nested-group concept exists anywhere in the schema, DTOs, or API; no dynamic/rule-based membership exists; no Alert-sending, recipient-resolution, Twilio/SES, or delivery-tracking code was introduced.

### Cross-cutting bug found and fixed during live browser validation

Real-browser validation of `DELETE /groups/:id/members/:contactId` failed with `net::ERR_FAILED` even though `curl` and the backend's own `app.inject()`-based test suite both reported a clean `204`. The actual cause was a **pre-existing CORS gap in `backend/src/app.ts`**: `@fastify/cors` was registered without an explicit `methods` list, so it defaulted to `GET,HEAD,POST` — silently blocking every real-browser `PATCH` and `DELETE` request across the *entire* application (this affects Contacts/Users edit, not just Groups), while never surfacing as a failure in `curl` or Fastify's `inject()` test harness, since neither of those enforces CORS at all. Module 06 happened to be the first module to add a `DELETE` route, which is what made the gap concretely block a real workflow rather than sit latent. Fixed by adding `methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"]` to the CORS registration — re-verified live afterward that both the `DELETE` member-removal and `PATCH` group-edit flows work correctly through the real browser, and re-ran the full test suite (233 tests, all still passing) to confirm the fix has no other effect, since `app.inject()` was never exercising this path either way.

## Tests

- **Integration** (`backend/src/test/groups/routes.integration.test.ts`, 23 tests, live `beacon_dev`): full RBAC matrix (ADMIN/COMMUNICATION_MANAGER full access; AUDITOR read-only; INCIDENT_COMMANDER read-only per its documented grant; RESPONDER denied; unauthenticated 401), group CRUD (create, blank-name rejection, case-insensitive duplicate-name rejection, malformed-UUID 400, unknown-UUID 404, search/list, mass-assignment-safe update, disable/enable), membership (bulk add with per-id `added`/`alreadyMember`/`notFound` classification, idempotent repeat-add, nonexistent-Contact and nonexistent-Group handling, paginated/searchable member listing, a Contact belonging to multiple Groups, remove-without-deleting-the-Contact), inactive-Contact behavior (added-while-already-inactive, disabled-after-being-added — both cases verifying `contactStatus` and count correctness), and audit/response-safety (no PII in `GROUP_*` audit metadata, no auth-secret fields in any response).
- **Frontend** (`frontend/src/groups/GroupsPage.test.tsx`, 4 tests; `App.test.tsx`, +1 test): list/create flow, inactive-member badge display plus Contact search-and-add, member removal, and Groups-nav permission gating.
- One pre-existing test file (`backend/src/test/rbac/permissions.test.ts`) needed its hardcoded AUDITOR/ADMIN expected-permission-set literals updated to include the five new Module 06 codes — the same kind of update every prior module's RBAC expansion has required of that file; not a regression.

Total: 233 tests passing (23 frontend + 198 backend + 12 database).

## Live validation performed

Live PostgreSQL (`beacon_dev`, credentials never displayed): migration applied, the case-insensitive partial unique index and `groups_status_idx`/check constraint confirmed present, all five `groups.*` permissions and their role mappings confirmed, seed idempotency reconfirmed (two runs, unchanged: 17 permissions, 33 mappings).

Live workflow (`curl` against the real running backend, four throwaway actor accounts — ADMIN/COMMUNICATION_MANAGER/AUDITOR/RESPONDER — created directly via the auth module's own hashing code): as ADMIN, created three synthetic Contacts (A/B/C) → created a Group → added A and B, verified `memberCount`/`activeMemberCount` both `2` → re-added A (idempotent: `added: []`, `alreadyMember: ["A"]`, count unchanged) → attempted a case-insensitive duplicate Group name (correctly rejected, `409 duplicate_group_name`) → added C → disabled Contact B → verified B remained a member with `contactStatus: "inactive"` and `memberCount` stayed `3` while `activeMemberCount` dropped to `2` → removed C → verified Contact C still existed and was still `active` → disabled the Group → re-enabled it. Verified COMMUNICATION_MANAGER can fully manage Groups; verified AUDITOR can read but gets `403` on create; verified RESPONDER gets `403`; verified unauthenticated gets `401`. Inspected all 7 `GROUP_*` audit rows directly and confirmed zero occurrences of a test Contact's actual name in any of them. Repeated the core flow through the **actual React frontend in a real browser**: logged in, viewed the card-grid Groups list (matching curl-created data exactly), created a new Group through the UI, searched Contacts and bulk-added two of them, removed one member, edited the Group's description, and disabled/re-enabled it — this pass is what surfaced and led to fixing the CORS `methods` gap described above. All live-validation Groups, Contacts, memberships, audit rows, and actor accounts were removed afterward — `beacon_dev` confirmed back to 0 users, 0 contacts, 0 groups, 0 group_members (seed-only state).

## Known limitations / follow-up

- **No bulk "manage many Groups at once" UI** — each Group's membership is managed independently, which is appropriate for this module's scope; a cross-Group bulk-membership tool wasn't requested and would be premature ahead of Module 09's actual alert-targeting needs.
- **The Contact-search-to-add UI defaults to active Contacts only** — a deliberate frontend UX default (adding a Contact you can't currently reach is unusual), not a backend restriction; the API itself will add an inactive Contact if a caller explicitly requests it.
- As in prior modules, live-validation actor accounts were created via a temporary non-interactive script rather than `bootstrap-user.ts`'s interactive prompts, due to the same documented Windows/Node readline automation limitation — not a limitation of Module 06 itself.
- The CORS `methods` fix (see Security review) is a genuine, previously-latent cross-cutting bug affecting `PATCH`/`DELETE` from a real browser project-wide, not something introduced by this module — flagged here because Module 06's live browser validation is what surfaced it, and it's now fixed for every module, not just this one.
