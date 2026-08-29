# database/

BEACON's PostgreSQL schema, Drizzle ORM migrations, connection client, and seed data. Consumed by `backend` as the `@beacon/database` workspace package.

## Scope (Module 01 — Database Foundation)

This package establishes the foundation schema for all 14 core tables (`users`, `roles`, `user_roles`, `contacts`, `groups`, `group_members`, `templates`, `incidents`, `incident_participants`, `alerts`, `alert_recipients`, `chat_messages`, `guest_invitations`, `audit_logs`) plus a reusable connection pool and database health check. It does **not** implement business logic (login, RBAC, alert sending, WebSocket chat, guest verification, etc.) — that belongs to later modules.

## Layout

```
src/
  schema/        One file per table group, exported from schema/index.ts
  client.ts       Reusable connection pool, config loader, health check
  migrate.ts      Applies committed migrations (programmatic, non-destructive)
  seed.ts         Idempotent system-role seed
  status.ts       Prints applied migrations + seeded roles
  test/           Static schema/config tests (no live database required)
migrations/       Committed, generated SQL migration history (do not hand-edit)
drizzle.config.ts Drizzle Kit configuration (schema path, output, dialect)
```

## Commands

Run from the repository root:

```bash
npm run db:generate   # Diff schema/ against migration history, write new SQL migration(s)
npm run db:migrate     # Apply any pending, committed migrations to DATABASE_URL
npm run db:seed        # Idempotently ensure the 5 system roles exist
npm run db:status      # List applied migrations and seeded roles
```

All four require `DATABASE_URL` — copy `.env.example` to `.env` first (see the root [README](../README.md)).

## Migration policy

- Migrations are generated with `drizzle-kit generate` and **committed to `migrations/`** — this is the only source of schema history.
- Migrations are applied with `db:migrate`, which runs Drizzle's migrator programmatically against the committed SQL files. This is the **normal path for every environment, including production**.
- `drizzle-kit push` (schema auto-sync) is **not used** as a migration method — it is destructive/non-reviewable and is not wired into any script.
- Never hand-edit a committed migration file. If a mistake ships, add a new corrective migration.

## Local backup and restore

With the Docker Compose PostgreSQL service running (`docker compose up postgres`):

```bash
# Backup (custom format, compressed)
docker compose exec postgres pg_dump -U beacon -d beacon_dev -F c -f /tmp/beacon_dev.dump
docker compose cp postgres:/tmp/beacon_dev.dump ./beacon_dev.dump

# Restore into a running (empty) database
docker compose cp ./beacon_dev.dump postgres:/tmp/beacon_dev.dump
docker compose exec postgres pg_restore -U beacon -d beacon_dev --clean --if-exists /tmp/beacon_dev.dump
```

For a plain-SQL backup instead: `docker compose exec postgres pg_dump -U beacon -d beacon_dev > backup.sql`, restore with `docker compose exec -T postgres psql -U beacon -d beacon_dev < backup.sql`.

## Migration recovery / rollback considerations

- Drizzle's migrator applies migrations forward-only and records each applied file in a `drizzle.__drizzle_migrations` tracking table; there is no built-in automatic "down" migration.
- To roll back a bad migration in a lower environment: restore the most recent backup taken before the migration ran, or write and apply a new corrective migration that reverses the change (preferred for any environment with real data).
- Because every foundation table uses `created_at`/`updated_at` (and `deleted_at` where soft-delete applies), most application-level mistakes can be corrected with a targeted `UPDATE`/`DELETE` rather than a schema rollback.
- Automated disaster-recovery tooling is out of scope for this module.

## Notes

- `drizzle-orm` is also listed in the **root** `package.json` devDependencies. This is required so `drizzle-kit` (hoisted to the workspace root by npm) can resolve `drizzle-orm`'s version-compatibility check at its own location — without it, `drizzle-kit generate` fails even though the actual dependency lives in `database/`. It is not used directly at the repository root.
