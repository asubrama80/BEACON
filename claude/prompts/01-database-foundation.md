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

## Acceptance criteria

- [x] A. Drizzle ORM configured (`drizzle.config.ts`, `drizzle-orm`, `drizzle-kit`).
- [x] B. Reusable PostgreSQL connection exists — `getDb()` builds a single pooled `postgres.Sql` client once and reuses it; never a new connection per request.
- [x] C. All required foundation tables exist — 14/14 generated in `migrations/0000_brave_skullbuster.sql` (verified by `db:generate` output and `migrations.test.ts`).
- [x] D. Contacts are independent from users — no `user_id` column on `contacts` (verified by `schema.test.ts`).
- [x] E. `incident_participants` supports registered users, contacts, and temporary guests without forcing a user account — three nullable references + `incident_participants_reference_check`.
- [x] F. `alert_recipients` does not require a BEACON user — `contact_id` nullable + `alert_recipients_target_check`.
- [x] G. Five required roles are seeded — `SYSTEM_ROLE_CODES` = `ADMIN`, `INCIDENT_COMMANDER`, `COMMUNICATION_MANAGER`, `RESPONDER`, `AUDITOR` (verified statically; live seed run not possible — see environment limitation).
- [x] H. Migrations are generated and committed — `database/migrations/0000_brave_skullbuster.sql` + `meta/` committed.
- [x] I. Seed is idempotent — `insert(...).onConflictDoNothing({ target: roles.code })`; safe to re-run (logic reviewed, not live-verified — see environment limitation).
- [x] J. `GET /health` remains functional and reports DB health safely — verified against the running built server (200, `database.connected: false`, no leaked credentials); Module 00's original test assertions unchanged and still passing.
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
- `npm run db:generate` — produced `0000_brave_skullbuster.sql` (14 tables, all FKs/checks/indexes as designed); inspected by hand.
- Static schema tests (`schema.test.ts`) assert key structural properties (contacts independence, `incident_participants`/`alert_recipients` nullability + check constraints, audit_logs append-only shape, role uniqueness) without requiring a live database.
- Migration integrity test (`migrations.test.ts`) asserts the committed SQL defines all 14 expected tables.
- Backend built and started (`node dist/index.js`); `GET /health` verified live returning HTTP 200 with `database.connected: false` (no Postgres available) and no leaked connection details.
- `git diff --check` — clean.

## Environment limitation

Docker (and any local PostgreSQL installation) is unavailable in this development environment, same as Module 00. This means:

- `db:migrate`, `db:seed`, and `db:status` could not be run against a live database.
- Seed idempotency (criterion I) and the actual presence of 5 seeded role rows (criterion G) were validated by code review and static tests only, not by running the seed twice against a real database.
- The generated migration SQL was reviewed by hand for correctness but not applied to a live PostgreSQL instance.

This should be re-verified — `npm run db:migrate && npm run db:seed && npm run db:seed` (confirming the second run is a no-op) and `npm run db:status` — the first time this repository runs on a machine with Docker/PostgreSQL available.
