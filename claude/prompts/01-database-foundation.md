# Module 01 — Database Foundation

## Scope

Establish the production PostgreSQL data foundation for BEACON using Drizzle ORM: configuration, a reusable connection pool, committed migrations, an idempotent system-role seed, database health integration, and the initial foundation schema for all 14 core tables. This module creates schema only — it does not implement the business logic (login, RBAC, contact/group CRUD, alert sending, WebSocket chat, guest verification, audit UI, incident workflows) that later modules own.

## Package structure

A new `@beacon/database` npm workspace (`database/`) owns the schema, connection client, migrations, and seed:

```
database/src/schema/    One file per table group (roles, users, contacts, groups, templates,
                         incidents, guestInvitations, incidentParticipants, alerts,
                         alertRecipients, chatMessages, auditLogs)
database/src/client.ts  loadDatabaseConfig, getDb (singleton pool), checkDatabaseHealth, closeDb
database/src/migrate.ts Programmatic migrator (drizzle-orm/postgres-js/migrator)
database/src/seed.ts    Idempotent system-role seed (onConflictDoNothing on role code)
database/migrations/    Committed, generated SQL — the only schema history
```

`backend` depends on `@beacon/database` as a workspace package and consumes `checkDatabaseHealth()` (in `GET /health`) and `closeDb()` (Fastify `onClose` hook for graceful shutdown).

## Important design decisions

**Enums avoided in favor of `varchar` + `CHECK` constraints**, per the module spec — every status/type/channel/severity column is a `varchar` with a `CHECK (... IN (...))` constraint. This keeps future operational changes (adding a status value) a plain migration instead of a `PostgreSQL ENUM` alteration.

**`incident_participants` models BEACON's three participation types without forcing a login.** `participant_type` (`user` | `contact` | `guest`) pairs with three nullable reference columns (`user_id`, `contact_id`, `guest_invitation_id`). A `CHECK` constraint (`incident_participants_reference_check`) enforces that exactly the one reference matching `participant_type` is set and the other two are null — so a contact or temporary guest can be a full War Room participant with no `users` row required.

**`alert_recipients` never requires a BEACON user.** `contact_id` is nullable; `recipient_name`/`recipient_address` capture an external/manual recipient as a snapshot. A `CHECK` constraint (`alert_recipients_target_check`) requires at least `contact_id` or `recipient_address` to be present, so delivery can target a directory contact or a one-off address.

**`contacts` has no `user_id` column at all** — not nullable, not present — enforcing independence from `users` at the schema level, not just by convention.

**`audit_logs` is append-only by construction**: no `updated_at`, no `deleted_at`. `actor_id` and `resource_id` are intentionally not foreign-keyed (the actor/resource can come from several different tables, and a log entry must survive deletion of the row it describes).

**Migrations are committed SQL, applied programmatically — never `drizzle-kit push`.** `db:generate` diffs `schema/` against migration history and writes SQL to `database/migrations/`; `db:migrate` applies pending migrations via Drizzle's migrator. This is the only production migration path.

**`GET /health`'s existing contract is preserved.** The top-level `status` field still means "the API responded" (`"ok"`) regardless of database state — it was not repurposed to reflect DB health, which would have broken Module 00's existing test. Database connectivity is reported separately as a nested `database: { connected: boolean }` field that never throws and never includes the connection string or credentials.

**Root `package.json` lists `drizzle-orm` as a devDependency.** npm hoisted `drizzle-kit` to the workspace root but left `drizzle-orm` nested under `database/node_modules`; `drizzle-kit`'s internal compatibility check resolves `drizzle-orm` relative to its own (root) location and failed with a misleading "Please install latest version of drizzle-orm" error until `drizzle-orm` was also hoisted to root. It is not used directly at the repository root — see `database/README.md`.

**`vitest` was bumped to `^4.1.11` across all workspaces** (from the `^2.1.8` pinned in Module 00) because `vitest@2` pulled in `vite@5` as a nested peer, conflicting with the frontend's `vite@6` and breaking `@vitejs/plugin-react`'s types. `vitest@4` supports `vite@6`, resolving the conflict; this is a tooling correction, not new Module 01 scope.

**`incident_participants`'s `guest_invitation_id` foreign key has an explicit, shortened constraint name** (`incident_participants_guest_invitation_fk`, via `foreignKey()`) instead of Drizzle's auto-generated name, which is 68 characters — over PostgreSQL's 63-byte `NAMEDATALEN` limit — and gets silently truncated. See "Defects found during runtime validation" below.

## Acceptance criteria

- [x] A. Drizzle ORM configured (`drizzle.config.ts`, `drizzle-orm`, `drizzle-kit`).
- [x] B. Reusable PostgreSQL connection exists — `getDb()` builds a single pooled `postgres.Sql` client once and reuses it; never a new connection per request.
- [x] C. All required foundation tables exist — 14/14 generated in `migrations/0000_brave_skullbuster.sql` (verified by `db:generate` output, `migrations.test.ts`, and a live `information_schema.tables` query against `beacon_dev`).
- [x] D. Contacts are independent from users — no `user_id` column on `contacts` (verified by `schema.test.ts`).
- [x] E. `incident_participants` supports registered users, contacts, and temporary guests without forcing a user account — three nullable references + `incident_participants_reference_check`.
- [x] F. `alert_recipients` does not require a BEACON user — `contact_id` nullable + `alert_recipients_target_check`.
- [x] G. Five required roles are seeded — `SYSTEM_ROLE_CODES` = `ADMIN`, `INCIDENT_COMMANDER`, `COMMUNICATION_MANAGER`, `RESPONDER`, `AUDITOR`. Live-verified: `npm run db:seed` against `beacon_dev` on the local PostgreSQL 18 instance produced exactly these 5 rows.
- [x] H. Migrations are generated and committed — `database/migrations/0000_brave_skullbuster.sql` and `0001_cloudy_lightspeed.sql` (+ `meta/`) committed. Both applied live to `beacon_dev` via `npm run db:migrate`.
- [x] I. Seed is idempotent — `insert(...).onConflictDoNothing({ target: roles.code })`. Live-verified: `npm run db:seed` run twice against `beacon_dev` produced the same 5 roles both times, no duplicates.
- [x] J. `GET /health` remains functional and reports DB health safely — verified against the running built server against `beacon_dev` (200, `database.connected: true`, no leaked credentials); Module 00's original test assertions unchanged and still passing.
- [x] K. Lint passes (frontend, backend, database).
- [x] L. Typecheck passes (frontend, backend, database — strict mode).
- [x] M. Tests pass — frontend 1/1, backend 2/2, database 12/12.
- [x] N. Production builds pass (database, backend, frontend — in that dependency order).
- [x] O. No secrets committed — `.env` git-ignored; only `.env.example` (placeholders) tracked.
- [x] P. Stakeholder prototype unchanged.
- [x] Q. No Module 02+ business behavior implemented (no login, RBAC, CRUD, sending, WebSocket, verification, or workflow logic).

## Validation performed

- `npm install` (workspace install + `postinstall` build of `@beacon/database`).
- `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build` — all pass across `frontend`, `backend`, `database`.
- `npm run db:generate` — produced `0000_brave_skullbuster.sql` (14 tables, all FKs/checks/indexes as designed) and later `0001_cloudy_lightspeed.sql` (FK rename fix); both inspected by hand.
- Static schema tests (`schema.test.ts`) assert key structural properties (contacts independence, `incident_participants`/`alert_recipients` nullability + check constraints, audit_logs append-only shape, role uniqueness) without requiring a live database.
- Migration integrity test (`migrations.test.ts`) asserts the committed SQL defines all 14 expected tables.
- Backend built and started (`node dist/index.js`); `GET /health` verified live returning HTTP 200 with `database.connected: true` against `beacon_dev` and no leaked connection details.
- `git diff --check` — clean.

## Runtime validation against PostgreSQL 18 (local Windows instance)

Originally deferred because Docker/PostgreSQL was unavailable in the development environment (see Module 00's equivalent note). Completed once a pre-existing local PostgreSQL 18 installation (Windows service `postgresql-x64-18`, port 5432) was made available with a dedicated `beacon_dev` database and `beacon_app` login, fully independent of that machine's other (Portal) database.

- `npm run db:migrate` — both migrations applied cleanly to `beacon_dev`.
- All 14 expected tables confirmed present via a live `information_schema.tables` query.
- `npm run db:seed` run twice — 5 roles present after the first run, still exactly 5 (no duplicates) after the second — idempotency confirmed live.
- All 5 required role codes confirmed present: `ADMIN`, `INCIDENT_COMMANDER`, `COMMUNICATION_MANAGER`, `RESPONDER`, `AUDITOR`.
- `npm run db:status` confirmed (after the fix below) 2 applied migrations and 5 seeded roles.
- `GET /health` against the running built backend returned HTTP 200 with `database.connected: true`, no credentials in the response.
- Full `lint`/`typecheck`/`test`/`build` re-run clean after all fixes below.

### Defects found during runtime validation (fixed)

1. **`seed.ts` silently did nothing when run via `npm run db:seed`.** Its "am I the entrypoint" guard compared `import.meta.url` against `new URL(process.argv[1], "file:")`, which does not correctly convert a Windows filesystem path (backslashes, drive letter) to a file URL, so the condition was always false and `main()` never ran — the script exited 0 with no error and no output. Fixed by using `pathToFileURL(process.argv[1]).href` from `node:url` instead.
2. **`status.ts` always reported "Applied migrations: 0"`,** even after a successful migration. Its query selected a `tag` column from `drizzle.__drizzle_migrations`, but that table's actual columns are `id`, `hash`, `created_at` — the query threw, and a blanket `.catch(() => [])` silently swallowed the error. Fixed by querying the correct columns and narrowing the catch to only swallow the specific "table does not exist yet" case (`42P01`, i.e. before the first migration has ever run).
3. **`incident_participants`'s `guest_invitation_id` foreign key name exceeded PostgreSQL's 63-byte identifier limit** (68 chars), silently truncated by Postgres with a `NOTICE` on every migration run. Fixed by giving it an explicit, short constraint name (`incident_participants_guest_invitation_fk`) via `foreignKey()`, captured in a new corrective migration (`0001_cloudy_lightspeed.sql`) rather than hand-editing the committed `0000` migration.

All three were caught only by actually running the migration/seed/status commands against a live database — none were reachable by the static tests alone, which is exactly why this runtime validation pass mattered.
