# BEACON Test Strategy

The durable, operational description of how BEACON is tested — written as part of Module 24, but
describing the strategy the whole codebase has followed since Module 02 and formalizing it going
forward. See [MODULE_24_TEST_REPORT.md](MODULE_24_TEST_REPORT.md) for what this module specifically
found and added.

## Scope

Covers the application built through Module 23: Authentication, Users/RBAC, Contacts, Import,
Groups, Templates, Incidents, Alerts, Notification Providers, Delivery Tracking, Command Center,
Chat, War Room foundation, Guest Invitations/OTP/Participants, Audit, Dashboard, Administration,
and the Module 23 security hardening pass. Explicitly **not** in scope: Modules 15/16 (Audio/Video,
Screen Sharing — deferred), Module 25 (Deployment), Module 26 (Production Readiness), Module 27
(Provider Configuration UI).

## Environments

- **Local developer workstation** — the only environment this strategy currently targets. All
  integration tests require a reachable `DATABASE_URL` and skip cleanly (`describe.skipIf`) when
  one isn't available, so the suite stays runnable without a database for quick unit-level checks.
- **CI (GitHub Actions or equivalent)** — not yet wired up (Module 25's concern), but every test
  command below is already CI-shaped: no interactive prompts, no developer-specific paths, no real
  provider credentials, no manually-started frontend, and `describe.skipIf(!process.env.DATABASE_URL)`
  means a CI job just needs a Postgres service container and `DATABASE_URL` set.
- **Timezone**: tests never assume a specific local timezone; date/time assertions either use
  UTC-normalized comparisons or directly manipulate stored timestamps rather than relying on
  wall-clock behavior.

## Test layers

1. **Unit** — pure functions with no I/O (password policy, TOTP, OTP hashing, Twilio signature
   computation, SMS segment counting). Fast, no `DATABASE_URL` needed.
2. **Service/domain** — a handful of tests exercise service functions directly where HTTP framing
   adds no value (e.g. `dispatchEngine.test.ts`'s provider-outcome injection).
3. **API/integration** — the dominant layer. Real Fastify app (`buildTestApp()`), real PostgreSQL,
   `app.inject()` for HTTP, real `ws` sockets for WebSocket routes. This is the layer that proves
   authorization boundaries, request/response shapes, and business rules actually hold end-to-end —
   deliberately preferred over mocking the framework or the database.
4. **Database constraints** — `backend/src/test/dbConstraints/` — direct `db.insert()` calls that
   bypass service-layer validation entirely, proving the schema itself (unique indexes, check
   constraints) is the real safety net, not just a service-layer pre-check a future bug could
   route around.
5. **Security regression** — `backend/src/test/security/` (Module 23) plus security-relevant
   assertions embedded throughout the other integration suites (CSRF, RBAC denial, Guest isolation,
   PII/secret absence).
6. **Concurrency/race** — `backend/src/test/concurrency/` (Module 24) plus concurrency tests
   embedded in `guestParticipant.integration.test.ts`, `dispatch.integration.test.ts`,
   `dispatchEngine.test.ts`, and `security.integration.test.ts` — every one uses genuine
   `Promise.all` simultaneous requests, never sequential calls dressed up as a race.
7. **WebSocket** — `backend/src/test/chat/chatWebsocket.test.ts` and the Guest-chat/War-Room
   sections of `guestParticipant.integration.test.ts` — real listening HTTP server
   (`app.listen({port:0})`), real `ws` client connections (Fastify's `inject()` cannot exercise a
   WS upgrade).
8. **End-to-end workflow** — `backend/src/test/e2e/criticalWorkflows.integration.test.ts` (Module
   24) — the one place a full cross-module journey (login → Incident → Alert → Guest →
   Audit → Administration) is exercised in sequence, rather than every suite staying scoped to its
   own module.
9. **Moderate load/stress** — `scripts/load/` (Module 24) — standalone Node scripts, never part of
   the normal suite. See "Load testing approach" below.
10. **Failure/recovery** — provider failure/retry (`dispatchEngine.test.ts`), malformed webhook
    payloads (`twilioWebhook.test.ts`, `sesWebhook.test.ts`), invalid provider configuration
    (`notifications/registry.test.ts`, `security/security.integration.test.ts`), transaction
    rollback (`backend/src/test/transactionRollback/`).

Frontend has its own two layers: component tests (`@testing-library/react` + `jsdom`, one file per
page/major component) and `App.test.tsx`'s shell-level integration tests (auth state, permission-
gated navigation, deep-linking between pages).

## Tooling

- **Vitest 4** for all three workspaces (backend, frontend, database) — a single test runner
  across the whole monorepo, no separate framework per layer.
- **`app.inject()`** (Fastify's built-in test client) for HTTP-level integration tests — no
  `supertest` or similar needed.
- **`ws`** (already a dependency) for real WebSocket client connections in tests that need an
  actual listening server.
- **`otpauth`** for generating valid TOTP codes in MFA tests.
- **Synthetic RSA/HMAC signing** (Node's `crypto` module) for Twilio/SES webhook signature tests —
  no real provider account needed.
- **`@testing-library/react` + `jsdom`** for frontend component tests.
- **`@vitest/coverage-v8`** (added this module) for on-demand coverage insight — not a CI gate, not
  a percentage target. Run via `npm run test:coverage --workspace backend`.
- **No mocking framework** (`vi.mock`/`vi.spyOn`) is used anywhere in the backend suite by
  deliberate convention — every integration test hits a real database and a real (in-process)
  Fastify app. This is a conscious choice, not an oversight: it catches real wiring bugs (e.g. the
  Module 24 chat-ordering bug, found only because a real WebSocket exercised real concurrent DB
  calls) that a mocked unit test would hide.

## Test-data strategy

- **Synthetic only, always.** Every test generates its own emails (`test-<module>-<role>-
  ${randomUUID()}@example.invalid`), phone numbers, and names. No real PII, no production data, no
  real provider credentials, no real OTP/invitation tokens ever appear in a test or in this
  repository.
- **Self-cleaning.** Every integration test file tracks the ids it creates and deletes them in
  `afterAll` (or, for single-test setups, inline). Cross-referenced rows (audit logs, timeline
  events, sessions) are deleted in dependency order before their parent row.
- **Deterministic where it matters.** Time-boundary tests (Module 24) manipulate real database
  timestamps directly (`UPDATE ... SET expires_at = <past>`) rather than sleeping — fast and
  reproducible. Concurrency tests use genuine `Promise.all`, not artificial delays, so a race either
  is or isn't actually closed — no timing-dependent flakiness from `setTimeout`-based coordination.
- **One connection pool per file.** Every integration test file calls `getDb()` once and does its
  own cleanup; only the **last** `describe` block in a given file (if a file has multiple) calls
  `app.close()`, since `buildApp()`'s `onClose` hook tears down the process-wide shared connection
  pool — closing it mid-file breaks every later describe's already-captured `db` reference. This is
  a real trap Module 24 hit twice (once in `security.integration.test.ts`, once while designing
  `concurrency.integration.test.ts`) and is now documented here so it isn't rediscovered.

## Concurrency approach

Every concurrency test in this codebase fires genuinely simultaneous requests via `Promise.all` (or
`Promise.race` where only the first outcome matters) against the same resource, then asserts an
invariant that would be violated by a real race: "exactly one of two concurrent X succeeds," "never
zero admins remain," "exactly one DB row results," "the final state is one of the valid outcomes,
never a third." Sequential `await a(); await b();` calls are never presented as a concurrency test —
several pre-Module-24 tests had exactly that naming mistake (e.g. a test titled "rejects a repeated
(concurrent-style) transition" that was actually sequential), and Module 24's own gap analysis
specifically hunted for and closed those gaps rather than trusting test names at face value.

## WebSocket approach

Chat's WebSocket routes require a real listening HTTP server (`app.listen({ port: 0 })`) since
Fastify's `inject()` cannot perform a genuine protocol upgrade. Every WS test follows the same
connection convention: attach the message listener **before** waiting for the "open" event
(buffering from creation), and wait for the server's own "connected" acknowledgement frame before
sending anything — sending immediately on client-side "open" races the server's async connection
setup and silently drops the first frame(s). This exact ordering bug was rediscovered independently
in a Module 24 load-testing script before being recognized as the same pattern the test suite's own
`connect()` helper already protects against; see [MODULE_24_TEST_REPORT.md](MODULE_24_TEST_REPORT.md)
for the real production-code ordering bug this same investigation uncovered.

## Load-testing approach

Deliberately lightweight, standalone Node/TypeScript scripts (`scripts/load/`), never part of the
normal Vitest suite (`npm test`/CI). Each script builds the real app in-process, listens on an
ephemeral port, drives it with real HTTP `fetch()`/WebSocket traffic at a moderate, explicitly-
bounded concurrency/volume, and always cleans up its own synthetic data in a `finally` block (a
gap discovered and fixed during this module — an earlier version left orphaned data behind on
failure and briefly broke unrelated tests). Results are printed to stdout, not asserted against a
hard threshold — the goal is an observed local baseline, not a production capacity guarantee. See
`scripts/load/*.ts` for the four scenarios (API, Chat, Alert-recipient-scale, Import-scale) and
[MODULE_24_TEST_REPORT.md](MODULE_24_TEST_REPORT.md) for the actual numbers captured.

## Failure-path approach

- **Provider failure** — the mock SMS/Email provider (`mockProvider.ts`) exposes an injectable
  outcome resolver (transient failure, permanent failure, timeout-shaped rejection), letting
  `dispatchEngine.test.ts` exercise retry/backoff/exhaustion without ever calling a real provider.
- **Malformed webhook** — both Twilio and SES webhook routes are tested against invalid signatures,
  missing signature headers, malformed/truncated payloads, and unknown correlation ids — always
  through the real HTTP route, never by calling the internal mapping function directly.
- **Invalid provider configuration** — `SMS_PROVIDER`/`EMAIL_PROVIDER` set to an unrecognized value
  must fail application startup, never silently fall back to mock (a real Module 23 finding, now a
  permanent regression test in both `notifications/registry.test.ts` and
  `security/security.integration.test.ts`).
- **DB/service failure** — this codebase does not use a mocking framework to simulate a DB outage
  (see "Tooling" above); instead, the two existing safety nets are relied on and were verified by
  direct code reading, not simulated: `checkDatabaseHealth()` never throws (catches internally,
  reports `{connected:false}`), and the single global Fastify error handler sanitizes any
  unexpected error into a generic 500 regardless of cause. A live database outage was deliberately
  not simulated against the shared dev database, per this module's own fail-stop rule against
  actions that could destabilize the local environment.
- **Transaction rollback** — `backend/src/test/transactionRollback/` proves the shared
  `db.transaction()` primitive every multi-step business flow depends on genuinely rolls back every
  write made before a later throw, across both a single-table and a multi-table case.

## Security regression integration

Module 23's security regression suite (`backend/src/test/security/`) is a permanent, standing part
of the normal test suite — it runs on every `npm test`, is not duplicated elsewhere, and is not
optional/opt-in. Module 24 added to it (the last-admin concurrency proof) rather than building a
parallel security suite. Core security regressions that must never silently regress: Guest/User
identity separation, RBAC permission boundaries, `audit.read` isolation, CSRF (double-submit-cookie,
tested on all 63 state-changing routes), CORS/WebSocket-Origin strictness, provider-config
fail-fast, PII/secret-absence assertions embedded in nearly every integration file's own tests, and
WebSocket authentication/authorization.

## CI suitability

Every test command below already runs non-interactively, uses only synthetic data, requires no real
provider credentials, and needs nothing beyond a reachable PostgreSQL instance
(`DATABASE_URL`) — no manually-started frontend dev server, no developer-specific file paths, no
assumption about the host's local timezone. The one thing **not** yet true: no GitHub Actions
workflow file exists (that's Module 25's concern, deliberately not started here). A future CI job
would need: a Postgres service container, `npm ci`, `npm run db:migrate && npm run db:seed`, then
the commands below.

## Known limitations

- **Process-local concurrency guarantees only** — the concurrency tests prove correctness within a
  single Node process (matching this application's actual current architecture); they say nothing
  about correctness across multiple deployed instances, which would need distributed locking this
  codebase doesn't have (a known, already-documented Module 13/23 limitation, not something Module
  24 introduces or resolves).
- **No real provider testing** — Twilio/SES adapters are tested for signature verification and
  webhook handling, never for actually placing a real API call (would require live credentials,
  explicitly out of scope per this module's own fail-stop rule).
- **No true production-scale load testing** — the load harness establishes a local baseline on one
  developer workstation; it is not a capacity-planning tool and makes no SLA claims.
- **No dedicated CI pipeline** — commands are CI-ready but not yet wired into an actual workflow.
- **Frontend E2E** — no browser-automation E2E suite (Playwright/Cypress) was introduced; frontend
  testing remains component-level (`@testing-library/react`) plus one live manual/browser-driven
  smoke pass per module, matching this module's own instruction not to install a large E2E platform
  without strong justification.

## Deferred deployment testing

Anything requiring a deployed environment, container orchestration, a reverse proxy, TLS
termination, or multi-instance coordination belongs to Modules 25/26 and is explicitly out of this
strategy's scope.

## Entry criteria (before a module's tests are considered complete)

- The module's own routes/services have integration coverage for: unauthenticated denial,
  no-permission denial, authorized success, and the module's specific business invariants.
- Any new DB constraint has a direct insertion-attempt test proving it's enforced at the schema
  layer, not just the service layer.
- Any new concurrency-sensitive operation (a check-then-act sequence) has a genuine `Promise.all`
  test proving the race is closed.

## Exit criteria (before a module is marked complete)

- Full regression suite (all three workspaces) passes at least 3 consecutive times with zero
  flaky/unexplained failures.
- `lint`, `typecheck`, `build` clean across all three workspaces.
- `git diff --check` clean, prototype unchanged, secret scan clean, PII review clean.
- Migration state and seed idempotency verified.
- `MASTER_CHECKLIST.md` updated for exactly the completed module.

## Test execution commands

All commands run from the repository root unless noted.

```bash
# Full suite, all three workspaces
npm test

# Per-workspace
npm run test --workspace backend
npm run test --workspace frontend
npm run test --workspace database

# Focused backend runs
npx vitest run src/test/security --dir backend           # security regression only
npx vitest run src/test/concurrency --dir backend         # concurrency/race suite only
npx vitest run src/test/chat --dir backend                 # WebSocket suite only
npx vitest run src/test/dbConstraints --dir backend        # database constraint suite only
npx vitest run src/test/e2e --dir backend                  # critical workflow suite only

# Coverage (backend; informational, not a gate)
npm run test:coverage --workspace backend

# Load harness (never part of the normal suite; run directly)
npx tsx scripts/load/api-load.ts
npx tsx scripts/load/chat-load.ts
npx tsx scripts/load/alert-recipient-scale.ts
npx tsx scripts/load/import-scale.ts

# Quality gates
npm run lint
npm run typecheck
npm run build

# Database
npm run db:status
npm run db:seed        # idempotent — safe to re-run
```

Requires `DATABASE_URL` reachable in the repository-root `.env` for every integration test; unit
tests with no database dependency still run without it.
