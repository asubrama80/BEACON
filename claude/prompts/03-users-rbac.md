# Module 03 — Users & RBAC

## Scope

Registered-user administration and permission-based authorization on top of Module 02's local authentication. Authentication answers "who are you?"; this module answers "what are you allowed to do?". Covers: a `permissions`/`role_permissions` schema, a reusable `requirePermission()` authorization guard, user CRUD (create/list/update/disable/enable), role assignment, an admin password-reset path, a last-active-administrator safeguard, break-glass account protection, audit events, and the minimum frontend admin UI. Contact management, custom-role creation, and RBAC administration UI beyond the fixed roles/permissions are out of scope — later modules (04+) own their own domains and permissions.

## Users vs. Contacts

Unchanged from Module 01/02's foundation: `users` are registered BEACON accounts capable of logging in; `contacts` (not touched by this module) are alert-recipient directory entries that never require a login and are never automatically granted one. Nothing in this module creates, reads, or links to `contacts` — Module 04 owns that table.

## RBAC architecture

```
backend/src/modules/rbac/
  permissions.ts   getEffectivePermissions (union), hasPermission, getUserRoles
  guard.ts          requirePermission(code) — the only sanctioned authorization preHandler
  routes.ts          GET /roles, GET /permissions (read-only)
backend/src/modules/users/
  dto.ts             Explicit response DTOs — never a raw DB row
  userQueries.ts     Query layer that never selects password_hash or other secrets
  lastAdmin.ts       countActiveAdmins / assertNotLastActiveAdmin
  breakGlass.ts       assertNotBreakGlass
  service.ts          Business logic: create/update/disable/enable/assignRole/removeRole/resetPassword
  routes.ts            All /users/* route handlers
database/src/schema/permissions.ts, rolePermissions.ts   New tables
database/src/permissionCodes.ts                            Module 03's permission codes (shared with the seed)
```

Authorization is **permission-based, never a role-name comparison** in business logic. Every protected route chains two preHandlers: `authenticate` (Module 02 — "is this a valid session?", 401 if not) then `requirePermission("resource.action")` ("does this user's effective permission set include this code?", 403 if not). The only two `role.code === "ADMIN"` references in the entire codebase are the last-administrator safeguard (`lastAdmin.ts`) and a code comment in `guard.ts` showing the anti-pattern to avoid — both audited and intentional, not general authorization logic.

## Permission naming convention

`resource.action` — stable, machine-readable, never renamed once shipped (the DB has a unique constraint on `code`, and nothing depends on `id`). Module 03 seeds exactly these seven:

| Code | Grants |
| --- | --- |
| `users.read` | List/view registered users |
| `users.create` | Create a registered user |
| `users.update` | Edit safe metadata; reset a password |
| `users.disable` | Disable or re-enable a user |
| `users.roles.assign` | Assign/remove roles on a user |
| `roles.read` | List the system roles |
| `permissions.read` | List permission codes |

No permissions for future modules (contacts, alerts, incidents, chat, war room, …) are pre-created — each module seeds its own when it's implemented, per CLAUDE.md's token-efficiency and no-future-module-work rules.

## Roles

The five existing system roles (`ADMIN`, `INCIDENT_COMMANDER`, `COMMUNICATION_MANAGER`, `RESPONDER`, `AUDITOR`) are untouched — not renamed, not deleted, no new roles added. Module 03 permission grants:

- **ADMIN** — all 7 Module 03 permissions (full user administration).
- **AUDITOR** — `users.read`, `roles.read`, `permissions.read` (read-only), matching its existing "Read-only access for compliance and audit review" description.
- **INCIDENT_COMMANDER, COMMUNICATION_MANAGER, RESPONDER** — none. Nothing in their current job (leading incident response, composing alerts, participating in War Rooms) justifies user-administration access yet; granting permissions "to fill out the role" was avoided per the module spec.

There is deliberately **no API to create custom roles or edit role-permission mappings at runtime** — `GET /roles` and `GET /permissions` are read-only. The role→permission mapping is entirely seed-managed (`database/src/seed.ts`). This keeps "who can do what" auditable from one file and avoids building destructive role-editing safeguards this module doesn't need yet; if a future module needs runtime-editable RBAC, it can add that deliberately.

## Effective permissions

A user's effective permissions are the **union** of every permission granted by every role assigned to them (`getEffectivePermissions`, `SELECT DISTINCT` joined through `user_roles` → `role_permissions` → `permissions`, returned as a `Set`). A user with both RESPONDER (0 permissions) and AUDITOR (3) ends up with exactly AUDITOR's 3 — deduplication is enforced at the SQL level (`DISTINCT`) and again structurally (`Set`). Verified live and in `permissions.test.ts` with real multi-role assignments against `beacon_dev`.

`GET /auth/me` (Module 02) now also returns `roles: string[]` and `permissions: string[]` (sorted, deduplicated) so the frontend can make UX decisions — but the frontend never enforces anything; the backend's `requirePermission()` on every route is authoritative regardless of what the UI shows or hides.

## Last-administrator safeguard

`countActiveAdmins(db, excludeUserId?)` counts active, non-deleted users holding the ADMIN role, optionally excluding one user — passing the user being acted on directly answers "how many active admins would remain after this?" for both the disable-user and remove-ADMIN-role cases, so one helper covers both. `assertNotLastActiveAdmin` throws `409 last_admin_protected` if that count would hit zero. Because only ADMIN currently carries `users.disable`/`users.roles.assign`, the only way to *reach* this guard is an admin acting on themselves as the sole remaining admin — there's no permission combination today that lets a non-admin (or a second admin) trigger it on someone else, since a second admin would mean the count never hits zero in the first place. This was verified directly: the test suite's admin actor, positioned as the database's sole active administrator (enforced by running test files sequentially — see below), is blocked from disabling itself or removing its own ADMIN role, with the row/assignment confirmed unchanged afterward.

**Test-suite note:** `backend/vitest.config.ts` sets `fileParallelism: false`. Several integration tests reason about global database state (specifically: "how many active administrators exist right now") — running test files in parallel workers would make that non-deterministic across files sharing one live database.

## Break-glass safeguard

`assertNotBreakGlass()` rejects (`403 break_glass_protected`) any PATCH, disable, enable, role-assignment, or password-reset request targeting a user with `is_break_glass = true` — full stop, no partial edits allowed through the ordinary API. Nothing in this module's create/update paths can ever set `isBreakGlass` (the field isn't in any request schema or allowlist), so no user can be converted into a second break-glass account through this API — combined with Module 02's DB-level partial unique index, this is defense in depth, not the only protection. The break-glass account's lifecycle remains bootstrap/operational-only (`backend/scripts/bootstrap-user.ts`), unchanged from Module 02.

## Session behavior on disable/enable/reset

- **Disable** and **password reset** both call `revokeAllSessionsForUser()` (added to Module 02's `session.ts`), setting `revoked_at` on every currently-unrevoked session for that user — access is cut immediately, not at next expiry. Verified live: an active session's `/auth/me` returns 401 the instant the admin action completes.
- **Enable** never restores anything — the disabled user must log in again from scratch. There is no "reactivate old session" code path to have gotten wrong.

## Response safety (DTOs)

`userQueries.ts` never selects `password_hash` (or any Module 02 secret column) in the first place — there is no raw row containing a secret anywhere in this module to accidentally serialize. `dto.ts` maps explicitly-selected safe columns into `UserSummaryDto`/`UserDetailDto`; no handler ever does `res.send(dbRow)`. Verified live (`JSON.stringify` scans of API responses) and in the integration suite.

## Mass-assignment defense

Every mutating request schema (`createUserBodySchema`, `updateUserBodySchema`, `assignRoleBodySchema`, `resetPasswordBodySchema`) sets `additionalProperties: false`. Fastify's default AJV configuration **strips** unrecognized properties rather than rejecting the request with an error (confirmed empirically — this is documented Fastify behavior, not a bug) — so a payload carrying `passwordHash`, `isBreakGlass`, or `status` still succeeds, but those fields are silently dropped before the handler ever sees them. This is a second, independent layer on top of the primary defense: the service layer (`service.ts`) never spreads the raw request body — every write reads named fields explicitly (`input.email`, `input.displayName`, …), so even if a stray field somehow survived schema stripping, nothing would ever read it. Verified live and in tests, which assert the forged fields have *zero effect* rather than asserting a particular HTTP status (matching Fastify's actual behavior).

## Audit events

`USER_CREATED`, `USER_UPDATED`, `USER_DISABLED`, `USER_ENABLED`, `USER_PASSWORD_RESET`, `USER_ROLE_ASSIGNED`, `USER_ROLE_REMOVED` — added to Module 02's `AuthAuditEventType` union and recorded via the same `recordAuthEvent()` helper, now also carrying `resourceType`/`resourceId` (added to `RecordAuthEventInput`) so the audited *target* user is distinguishable from the *actor* admin. Metadata carries only safe context (role codes, updated field names) — never passwords, hashes, or secrets. Verified live and via a metadata secret-pattern scan in tests.

## API summary

All routes require a valid session (`authenticate`) plus the named permission; all mutating routes additionally require the CSRF header (Module 02's double-submit cookie).

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/users` | `users.read` — paginated, searchable (email/name), status/role filterable |
| GET | `/users/:id` | `users.read` |
| POST | `/users` | `users.create` |
| PATCH | `/users/:id` | `users.update` — allowlist: `email`, `displayName` only |
| POST | `/users/:id/disable` | `users.disable` |
| POST | `/users/:id/enable` | `users.disable` |
| POST | `/users/:id/roles` | `users.roles.assign` — `{ roleCode }` |
| DELETE | `/users/:id/roles/:roleCode` | `users.roles.assign` |
| POST | `/users/:id/reset-password` | `users.update` |
| GET | `/roles` | `roles.read` |
| GET | `/permissions` | `permissions.read` |

## `bootstrap-user.ts` extended: optional role assignment

Discovered while validating this module end-to-end: there was no way to ever grant the *first*
ADMIN role. Assigning a role through `POST /users/:id/roles` requires `users.roles.assign`,
which requires already holding ADMIN — a fresh `beacon_dev` had no path out of that circle
without direct database surgery (which is exactly what the initial live-validation pass had to
resort to). The break-glass account has the same problem, compounded: once created, the
ordinary API refuses to touch it at all (`assertNotBreakGlass`), so bootstrap time is the
*only* opportunity it ever gets to receive a role.

Fixed by extending `backend/scripts/bootstrap-user.ts` with an optional "assign a role now?"
prompt (listing the live role codes from the database, validated against them) — bypassing the
HTTP API entirely and inserting into `user_roles` directly, consistent with break-glass
lifecycle already being documented as bootstrap/operational-only. The underlying role-resolution
and insert logic was verified directly against `beacon_dev` (assigns known codes, rejects
unknown ones, cleaned up afterward) — see "Known limitation" below for why this wasn't verified
through a full interactive terminal replay.

## Deliberately out of scope (with rationale)

- **Admin-triggered MFA reset for another user.** Module 02 already provides a fully authenticated self-service MFA disable/reset path; the spec explicitly cautioned against over-expanding this capability if that's sufficient. The remaining gap (an admin unlocking a *different* locked-out user's MFA) is a real but narrower operational need, deferred as a deliberate, documented decision rather than built under this module's time budget.
- **Forgot-password / email-based recovery.** Explicitly out of scope per the spec (no email-delivery dependency). The admin-driven `reset-password` endpoint is the supported recovery path.
- **Runtime role-permission editing / custom roles.** See "Roles" above — deliberately fixed and seed-managed for now.
- **A "must change password on first login" flag.** Reasonable future enhancement; would need a new column. Not requested explicitly, and skipped to avoid scope creep.

## Security review performed

- Grepped for role-name checks outside the two audited exceptions (the last-admin safeguard and a comment) — none found; removed one genuinely dead-code function (`userHasAdminRole`) that would have been a second, unused role-check surface.
- Confirmed all 11 new routes carry both `authenticate` and `requirePermission` (9 in `users/routes.ts`, 2 in `rbac/routes.ts`) and all 7 mutating routes call `requireCsrf`.
- Verified mass-assignment has no effect (see above) live and in tests.
- Verified disabled-user sessions are rejected immediately, live.
- Verified the last-admin and break-glass safeguards live and in tests (self-disable, self-role-removal, and all break-glass mutation attempts blocked).
- Verified no password hash, MFA data, or other secret appears in any user API response or audit metadata (`JSON.stringify` scans, live and in tests).
- All queries use Drizzle's parameterized query builder; the one raw `sql` template (`ANY(${...})` for role filtering) binds its interpolated array as a parameter, not string concatenation — no SQL injection surface.
- Frontend permission checks (`user.permissions.includes(...)`) gate visibility/UX only; every action still calls the real API, which independently authorizes server-side.

## Acceptance criteria

- [x] A. Permission-based RBAC exists.
- [x] B. Authorization is not based primarily on hard-coded role-name checks — verified by grep (see security review).
- [x] C. `permissions` and `role_permissions` tables exist — migration `0003_deep_radioactive_man.sql`.
- [x] D. Module 03 permission seed is idempotent — live-verified (re-ran `db:seed`, counts unchanged: 7 permissions, 10 role-permission mappings).
- [x] E. Existing system roles remain intact — unchanged, live-verified.
- [x] F. ADMIN receives all current Module 03 permissions — live and test-verified.
- [x] G. Multiple roles produce the union of effective permissions — test-verified with real multi-role assignment.
- [x] H. Reusable `requirePermission`-style guard exists.
- [x] I. New APIs distinguish 401 vs 403 correctly — live and test-verified.
- [x] J. Registered users can be listed/created/updated by authorized users — live and test-verified.
- [x] K. Roles can be safely assigned/removed — live and test-verified, including duplicate/missing-assignment handling.
- [x] L. Sensitive authentication fields cannot be mass-assigned — live and test-verified.
- [x] M. Disabled users lose access immediately — live and test-verified.
- [x] N. Last active administrator cannot be accidentally removed/disabled — live and test-verified.
- [x] O. Break-glass account is protected from ordinary user administration — live and test-verified (PATCH/disable/role-assign/reset-password all blocked).
- [x] P. Responses expose no authentication secrets — live and test-verified.
- [x] Q. User/RBAC changes are audited — live and test-verified, metadata scanned for secrets.
- [x] R. Frontend Users/RBAC flow works — verified in a real browser against the real backend.
- [x] S. Backend remains authoritative for authorization — frontend never bypasses the API.
- [x] T. Live PostgreSQL migration succeeds — applied to `beacon_dev`.
- [x] U. Live authorization flow succeeds — full admin → create → assign role → verify permissions → authorized call → 403 negative path → disable → session-rejected → re-enable → cleanup sequence, live.
- [x] V. Lint passes (frontend, backend, database).
- [x] W. Typecheck passes (frontend, backend incl. `scripts/`, database).
- [x] X. Tests pass — see Validation below.
- [x] Y. Production build passes (database, backend, frontend).
- [x] Z. Stakeholder prototype unchanged.
- [x] AA. No secrets committed — `.env` git-ignored; diff scanned before commit.
- [x] AB. No Module 04+ functionality implemented — no contacts, no custom roles, no cross-module permissions.

## Validation performed

- `npm install`, `npm run db:generate` / `db:migrate` (migration `0003_deep_radioactive_man.sql` applied to `beacon_dev`), `npm run db:seed` run twice (idempotent — second run left permission/mapping counts unchanged).
- `npm run lint`, `npm run typecheck`, `npm run build` — clean across `frontend`, `backend`, `database`.
- `npm run test` — 115 tests total: frontend 10 (App nav-visibility + UsersPage list/create), backend 93 (unchanged Module 01/02 suites + new `rbac/permissions.test.ts` and `users/routes.integration.test.ts`, the latter covering the full acceptance-criteria list above against live `beacon_dev`), database 12.
- **Live validation against `beacon_dev`** (native PostgreSQL 18, `DATABASE_URL` never displayed): created an admin user directly via the auth module's own password/config code, logged in through the running backend, ran the full create-user → assign-role → verify-effective-permissions → authorized-call → **negative 403 authorization path** → disable → verify-session-rejected → re-enable → `GET /roles`/`GET /permissions` sequence via `curl`, then repeated login → Users list → create user → assign role through the **actual React frontend in a real browser**. All test data (users, their sessions, and audit rows) removed afterward — `beacon_dev` confirmed back to 0 users, 5 roles, 7 permissions.

## Known limitation: `bootstrap-user.ts` interactive replay in automation

Carried over from Module 02: driving the script's full interactive prompt sequence end-to-end
from an automated harness (piped stdin, or `child_process.spawn` with staggered writes) is
unreliable on this Windows/Node 24 environment — a `readline/promises` quirk causes later
`question()` calls to hang in a way that was traced to environment/process-spawning behavior,
not the script's own logic (see Module 02's write-up for the original diagnosis). This session
worked around it, as Module 02 did, by validating the *underlying logic* directly (password
hashing/policy, and now role resolution/assignment) against live `beacon_dev` rather than a
full terminal replay. The script's real, intended usage — a human operator typing in an actual
terminal — is unaffected; only *automated* replay of it is unreliable here. Re-verify a real
interactive run on a machine with a genuine TTY before relying on this note further.
