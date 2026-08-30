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
- **Module 05 — Excel/CSV Import: complete.** Operator-reviewed bulk Contact import from CSV or XLSX: upload → map columns → preview (validation/normalization/duplicate detection, reusing Module 04's own logic) → operator decision → confirm → summary/audit. Uploading or previewing a file never creates a Contact; only an explicit confirm of operator-selected rows does. Permission-gated (`contacts.import`), safe file parsing (no formula/macro execution, bounded size/rows/columns), and a 5-step import wizard on the Contacts screen. See [claude/prompts/05-excel-csv-import.md](claude/prompts/05-excel-csv-import.md) for the full design. Groups and alert sending are not implemented yet.
- **Module 06 — Groups: complete.** Static, reusable Contact Groups: create/edit/disable/enable a Group, and bulk add/remove/list its membership. Membership is Contact-only — no nested Groups, no dynamic/rule-based membership, no dependency on an external directory. Case-insensitive Group-name uniqueness, `memberCount`/`activeMemberCount` on every Group, inactive Contacts remain historical members and are never silently hidden, permission-gated (`groups.read/create/update/disable/members.manage`), and a card-grid Groups screen with a member-management modal. See [claude/prompts/06-groups.md](claude/prompts/06-groups.md) for the full design. Alert sending and Templates are not implemented yet.
- **Module 07 — Templates: complete.** Reusable SMS/Email message content, safe token-only placeholder substitution (`{{firstName}}`/`{{lastName}}`/`{{displayName}}`, no executable syntax), a synthetic-values preview with SMS GSM-7/UCS-2 segment guidance, and create/edit/disable/enable lifecycle. A Template never identifies recipients or sends anything — that's Module 09's job. Permission-gated (`templates.read/create/update/disable`), and a card-grid Templates screen with an inline preview. See [claude/prompts/07-templates.md](claude/prompts/07-templates.md) for the full design. Incident Management and the Alert Engine are not implemented yet.
- **Module 08 — Incident Management: complete.** A durable Incident record: server-generated `INC-{year}-NNNNNN` identifier, an explicit `OPEN → ACTIVE → RESOLVED → CLOSED` lifecycle (CLOSED strictly terminal), an Incident Commander (any active registered User, distinct from the global `INCIDENT_COMMANDER` RBAC role — assignment never touches that User's roles), a Participant roster (registered Users and Contacts, never Guests), duplicate-participant prevention at the database layer, and a separate append-only, PII-free Incident Timeline alongside the existing audit log. Permission-gated (`incidents.read/create/update/lifecycle.manage/commander.assign/participants.manage/timeline.read`), concurrency-safe lifecycle/roster mutations, and an Incidents screen with Overview/Participants/Timeline detail views. See [claude/prompts/08-incident-management.md](claude/prompts/08-incident-management.md) for the full design. The Alert Engine, provider integration, realtime Chat, War Room, and Guest invitations are not implemented yet.
- **Module 09 — Alert Engine: complete.** The Alert Engine foundation: a durable, auditable communication plan combining an optional Incident link, one channel (SMS or Email — never both on one Alert), Template-based or ad-hoc content (reusing Module 07's renderer), Contact/Group recipient selection with server-authoritative resolution, dedupe-by-Contact-identity, and active/destination eligibility filtering. `DRAFT → READY → CANCELLED` lifecycle; READY freezes an immutable per-recipient snapshot (destination + fully rendered content) that later Template/Contact/Group edits can never alter. Permission-gated (`alerts.read/create/update/ready/cancel/recipients.read`, with recipient destination PII behind its own permission), server-side max-recipient safety limit, and an Alerts screen with an explicit Ready confirmation step. See [claude/prompts/09-alert-engine.md](claude/prompts/09-alert-engine.md) for the full design. This module does not send anything — no provider integration, retry logic, or delivery tracking exist yet.
- **Module 10 — Notification Providers: complete.** A provider-agnostic dispatch layer that submits Module 09's immutable READY Alert Recipient snapshots to an external SMS/Email provider — never re-resolving Contacts/Groups or re-rendering Templates. Mock (default, zero network calls), Twilio (SMS, via REST), and Amazon SES (Email, via the official SDK) adapters behind a central registry, selected by `SMS_PROVIDER`/`EMAIL_PROVIDER` env config; an unconfigured real provider fails safely at startup rather than silently falling back to mock. An explicit, separately-permissioned `alerts.dispatch` action (distinct from READY) with DB-enforced idempotency (a recipient can never be submitted twice), bounded retry with transient/permanent error classification, bounded concurrency, and an append-only `notification_dispatch_attempts` history free of PII/credentials. Provider acceptance is always called "submitted," never "delivered" — that distinction belongs to Module 11. See [claude/prompts/10-notification-providers.md](claude/prompts/10-notification-providers.md) for the full design. Delivery tracking, provider callbacks/webhooks, and the Incident Command Center are not implemented yet.
- **Module 11 — Delivery Tracking: complete.** Post-submission delivery tracking for Module 10's dispatched Alert Recipients — provider-neutral delivery states (`pending` → `delivered`/`undelivered`/`bounced`/`failed`), correlated purely by `(provider, providerMessageId)`, never by destination. A Twilio status-callback webhook with hand-rolled request-signature verification, and an SES-via-SNS event webhook with RSA-signature-verified message authenticity (SNS `SubscribeURL` is never auto-fetched — SSRF-safe by construction); both isolated from session auth/CSRF, idempotent via a DB-unique dedupe key, and immune to out-of-order/duplicate callbacks via a monotonic terminal-state rank rule. A development-only mock-delivery simulation endpoint (404 outside development/test) exercises the identical `processDeliveryEvent()` path real webhooks use. A safe aggregate delivery summary (never destination PII) is exposed on every Alert; a dual-permission-gated (`alerts.recipients.read` + new `alerts.delivery.read`) endpoint exposes per-recipient event history. Delivery callbacks continue to be processed for a CLOSED Incident or an already-dispatched Alert — historical reality is never erased. A single `ALERT_DELIVERY_COMPLETED` Incident-timeline/audit event fires exactly once, race-safe under concurrent completion. See [claude/prompts/11-delivery-tracking.md](claude/prompts/11-delivery-tracking.md) for the full design. Real Twilio/SES credentials were not available in this environment — Twilio/SES correctness was verified with synthetic signatures, not a live provider account. The Incident Command Center is not implemented yet.
- **Next: Module 12 — Incident Command Center.**

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
npm run db:seed      # idempotently ensure the 5 system roles + Module 03/04/05/06/07 permissions exist
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
