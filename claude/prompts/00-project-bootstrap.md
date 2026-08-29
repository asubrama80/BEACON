# Module 00 — Project Bootstrap

## Scope

Establish the production repository skeleton and local development foundation for BEACON. No business modules, database schema, or authentication are implemented in this module.

1. Production repository structure: `frontend/`, `backend/`, `database/`, `infrastructure/`, `tests/`, `docs/`, `claude/prompts/`.
2. Frontend: React + TypeScript (strict) + Vite application shell only — BEACON header/title, no business modules. Visual direction (colors, typography, brand mark) follows the stakeholder prototype without converting it.
3. Backend: Node.js + TypeScript (strict) + Fastify, modular folder structure, `GET /health` returning `status`, `application`, `environment`, `timestamp`. No database schema, no Drizzle, no authentication.
4. PostgreSQL as a Docker development service only: configurable via environment variables, persistent volume, health check. No application tables.
5. Docker Compose foundation for frontend, backend, and PostgreSQL local development. No Nginx production routing.
6. `.env.example` documenting frontend/backend/PostgreSQL configuration with development placeholders (no real credentials).
7. `.gitignore` covering dependencies, build artifacts, environment files, logs, IDE/runtime files, test artifacts, and local database volumes.
8. ESLint + Prettier + TypeScript strict type checking for both frontend and backend.
9. Test frameworks (Vitest) for frontend and backend, with a backend `/health` test and a frontend shell smoke test.
10. Root-level npm workspace scripts for setup, dev, lint, typecheck, test, build — no monorepo framework (Turborepo/Nx).
11. `README.md` describing purpose, architecture, stack, status, setup, and commands.

## Out of scope

- Module 01 (database schema/Drizzle) and any later module.
- Authentication, business domain UI, Nginx production routing.
- Modifying `docs/reference/beaconstakeholderprototype.html`.

## Acceptance criteria

- [x] A. Frontend starts successfully (`npm run dev --workspace frontend`) — verified: Vite serves on :5173, page renders "BEACON" shell with no console errors.
- [x] B. Backend starts successfully (`npm run dev --workspace backend` / built `npm run start`) — verified against the production build.
- [x] C. `GET /health` returns HTTP 200 — verified against the running built server: `{"status":"ok","application":"beacon-backend","environment":"development","timestamp":"..."}`.
- [ ] D. PostgreSQL Docker service starts and becomes healthy — **not runtime-validated**; Docker is unavailable in this environment (`docker: command not found`). `docker-compose.yml` was statically validated (parsed as valid YAML; `postgres:16-alpine` service defines env-configurable db/user/password, a persistent named volume, and a `pg_isready` healthcheck).
- [x] E. Frontend smoke test passes (`App.test.tsx` — renders BEACON heading and shell text).
- [x] F. Backend health test passes (`health.test.ts` — asserts 200 and response shape via `app.inject`).
- [x] G. Lint passes (frontend + backend, `--max-warnings 0`).
- [x] H. Typecheck passes (frontend + backend, `tsc --noEmit` / `tsc -b --noEmit`, strict mode).
- [x] I. Tests pass (frontend + backend, 1/1 each).
- [x] J. Production builds pass (frontend Vite build; backend `tsc` build).
- [x] K. No secrets committed — `.env` is git-ignored, only `.env.example` (placeholder values) is tracked; untracked files scanned for credential/key patterns with no hits.
- [x] L. Stakeholder prototype unchanged — not modified this module.
- [x] M. No Module 01+ functionality implemented — no database schema, Drizzle config, or authentication added.

## Known environment limitation

Docker is not installed in this development environment, so the PostgreSQL Docker service (criterion D) could not be started or health-checked at runtime. `docker-compose.yml` and both Dockerfiles were reviewed and statically validated instead. This should be re-verified the first time this repository is used on a machine with Docker available.
