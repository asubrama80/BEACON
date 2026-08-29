# BEACON

BEACON is an emergency communication and incident war-room platform. It lets responders send emergency alerts to contacts and groups, manage incidents, and collaborate in real time — chat, audio/video, and screen sharing — inside incident-scoped War Rooms that also support temporary, incident-specific guest access.

## Architecture

- **Modular monolith** — a single deployable frontend and backend, organized into feature modules built incrementally.
- **REST API** between frontend and backend, with **WebSocket** for realtime incident chat and collaboration.
- **Provider abstraction** for SMS, email, and realtime collaboration, so providers can be swapped without touching application logic.
- Portable and deployable under any domain, cloud, or hosting provider — no runtime dependency on corporate VPN, Active Directory, Microsoft 365, HR systems, or MDM.
- **Contacts** (alert recipients) and **application users** (people who log in) are separate concepts. Registered responders access Incident War Rooms as authenticated users; guests get incident-scoped temporary access.
- The stakeholder prototype at [docs/reference/beaconstakeholderprototype.html](docs/reference/beaconstakeholderprototype.html) is the approved **UI/UX source of truth**.

## Technology stack

| Layer | Technology |
| --- | --- |
| Frontend | React + TypeScript + Vite |
| Backend | Node.js + TypeScript + Fastify |
| Database | PostgreSQL + Drizzle ORM |
| Realtime | WebSocket |
| Deployment | Docker / Docker Compose + Nginx |

## Project status

Implementation proceeds **one numbered module at a time**. See [MASTER_CHECKLIST.md](MASTER_CHECKLIST.md) for the full module list and current status.

- **Module 00 — Project Bootstrap: complete.** Repository skeleton, frontend/backend application shells, PostgreSQL dev service, Docker Compose foundation, tooling, and CI-equivalent checks (lint/typecheck/test/build) are in place.
- **Module 01 — Database Foundation: complete.** PostgreSQL + Drizzle ORM foundation schema (14 core tables), a reusable connection pool, committed migrations, an idempotent system-role seed, and database health reporting on `GET /health`. No business logic (login, RBAC, alert sending, chat, guest verification) yet.
- **Module 02 — Authentication: complete.** Local email/password login (Argon2id), server-side sessions (HttpOnly + SameSite cookies), CSRF protection, login throttling, TOTP MFA with one-time recovery codes, a local emergency break-glass account, authentication audit events, a `bootstrap-user` CLI, and a minimal login/MFA/logout frontend. No enterprise identity provider (AD/Entra/Okta/LDAP/M365) dependency. See [claude/prompts/02-authentication.md](claude/prompts/02-authentication.md) for the full design.
- **Module 03 — Users & RBAC: complete.** Permission-based authorization (`requirePermission`, never role-name checks) on top of Module 02's sessions; registered-user administration (list/create/update/disable/enable, role assignment, admin password reset); a last-active-administrator safeguard and break-glass account protection; user/RBAC audit events; and a minimal Users admin frontend, visible only to permitted users. See [claude/prompts/03-users-rbac.md](claude/prompts/03-users-rbac.md) for the full design. Contacts and custom-role administration are not implemented yet.
- **Module 04 — Contacts: complete.** The BEACON contact directory — people BEACON can reach who are never automatically application users. Email/phone normalization, non-blocking duplicate detection with explicit override, active/inactive lifecycle (no hard delete), permission-based CRUD (`contacts.read/create/update/disable`), contact audit events, and a minimal Contacts admin frontend. See [claude/prompts/04-contacts.md](claude/prompts/04-contacts.md) for the full design. CSV/Excel import, Groups, and alert sending are not implemented yet.
- **Next: Module 05 — Excel/CSV Import.**

## Prerequisites

- Node.js 20+ and npm 10+
- Docker and Docker Compose (for the PostgreSQL development service; optional if you run PostgreSQL yourself)

## Local development setup

```bash
cp .env.example .env
npm install
```

### Start PostgreSQL (Docker)

```bash
docker compose up postgres
```

### Start the backend

```bash
npm run dev --workspace backend
```

Backend listens on `http://localhost:4000` by default (`BACKEND_PORT` in `.env`). Verify with:

```bash
curl http://localhost:4000/health
```

### Start the frontend

```bash
npm run dev --workspace frontend
```

Frontend serves on `http://localhost:5173` by default (`FRONTEND_PORT` in `.env`).

### Set up the database

With PostgreSQL running (Docker or otherwise) and `DATABASE_URL` configured in `.env`:

```bash
npm run db:migrate   # apply committed migrations
npm run db:seed      # idempotently ensure the 5 system roles + Module 03/04 permissions exist
npm run db:status     # list applied migrations, seeded roles, and permissions
```

`GET /health` reports database connectivity alongside application status (`{"database": {"connected": true|false}}`) without exposing credentials. See [database/README.md](database/README.md) for schema layout, migration policy, and backup/restore steps.

### Create a local user

```bash
npm run bootstrap-user --workspace backend
```

Interactive prompt (never accepts a password via flag/env var). Answer "y" to the break-glass question only for the single local emergency admin account — see [claude/prompts/02-authentication.md](claude/prompts/02-authentication.md) for the full break-glass process, including enrolling MFA immediately afterward. You can also assign a role (e.g. `ADMIN`) at creation time — this is the only way to grant the very first administrator, since assigning roles through the API itself requires already being one.

### Start everything with Docker Compose

```bash
docker compose up
```

### Start everything without Docker

```bash
npm run dev
```

## Commands

Run from the repository root (applies to the `frontend`, `backend`, and `database` workspaces):

```bash
npm run lint        # ESLint
npm run typecheck   # TypeScript --noEmit
npm run test        # Vitest
npm run build       # Production builds
```

Database-specific commands (`db:generate`, `db:migrate`, `db:seed`, `db:status`) are listed above.

## Project structure

```
frontend/            React + TypeScript + Vite application
backend/              Node.js + TypeScript + Fastify API
database/             PostgreSQL schema, Drizzle ORM, migrations, seed (@beacon/database)
infrastructure/       Production deployment configuration (added in later modules)
tests/                Cross-cutting integration/e2e tests (added as later modules land)
docs/
  reference/
    beaconstakeholderprototype.html   Approved UI/UX source of truth (read-only)
claude/
  prompts/            One implementation prompt per module, added when that module starts
CLAUDE.md              Permanent project rules for Claude Code sessions
MASTER_CHECKLIST.md    Module-by-module implementation checklist
docker-compose.yml     Local development orchestration (frontend, backend, PostgreSQL)
```
