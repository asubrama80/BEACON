# Module 23 — Security Hardening

## Scope

A systematic security review and hardening pass across Modules 00–22 — not merely adding headers or
a handful of tests. See [docs/security/SECURITY_REVIEW.md](../../docs/security/SECURITY_REVIEW.md)
for the full threat model, control inventory, findings, and residual-risk documentation; this file
covers the implementation decisions behind each fix.

## Provider configuration fail-fast (explicitly flagged item)

`notifications/config.ts`'s `readSmsProvider`/`readEmailProvider` previously mapped *any*
unrecognized value to `"mock"`, including an operator typo — meaning `getSmsProvider()`'s own
`default:` fail-fast branch (`registry.ts`) was unreachable dead code, since an invalid value never
survived to reach it. Fixed by having both functions distinguish "unset" (default to mock,
unchanged) from "explicitly set to something unrecognized" (throw, at config-load time — called
eagerly in `buildApp()`, so this fails the whole process at startup, before any request is ever
served). `registry.test.ts`'s prior test asserted the *old* silent-fallback behavior explicitly; it
was reversed to assert the throw instead, plus a matching new test for `EMAIL_PROVIDER`.

## Guest chat re-validation (real vulnerability found and fixed)

Discovered during the WebSocket security review (spec item 23.20, "removed Guest still-connected
socket"): removing a Guest participant revokes their session (blocking any *future* handshake), but
never proactively closes an already-open WebSocket. `sendGuestMessage()`'s authorization was a
closure-captured snapshot from connection time, never re-checked per message. Fixed by having
`sendGuestMessage()` (`chat/chatService.ts`) re-query the participant's live `incident_participants`
status on every send and reject with a new `guest_removed` (403) `AuthErrorCode` if it's no longer
active — "message operations revalidated promptly," the module spec's own accepted alternative to
proactively tracking and force-closing sockets (which would require new cross-module coupling
between the chat connection registry and the incidents service, judged unnecessary complexity for
what re-validation already solves). Verified end-to-end (not just at the service-function level) in
`participants/guestParticipant.integration.test.ts`: connect a real WebSocket while the Guest is
still active, remove them mid-connection via the existing DELETE participant route, attempt a `send`
frame on the still-open socket, assert the rejection and that nothing was persisted.

## Last-admin race condition (real vulnerability found and fixed)

`assertNotLastActiveAdmin()` was an unlocked, non-transactional "count minus one" read — spec item
23.23 explicitly asks to check exactly this ("last-admin safeguard cannot be defeated by two
concurrent requests"), and it could be: with exactly two active admins, two concurrent disable
requests targeting each of them could both read "1 remaining" before either commits.

Fix required care because Postgres rejects `FOR UPDATE` combined directly with a `DISTINCT` +
multi-table-join query (the existing `countActiveAdmins()` shape) — `ERROR: SELECT DISTINCT ... FOR
UPDATE is not allowed`. `assertNotLastActiveAdmin()` (now taking `DbOrTx`, matching this codebase's
established transaction-context type from `database/src/client.ts`) instead runs the join query
first (unlocked) to identify *which* users are currently active admins, then takes a second, plain
`SELECT ... FOR UPDATE` directly on `users` for exactly those candidate ids. Two transactions racing
over an overlapping candidate set correctly serialize on that row lock — the second transaction's
`FOR UPDATE` blocks until the first commits or rolls back, then re-reads the now-current `status`.
`disableUser()` and `removeRole()` (`users/service.ts`) were both wrapped in `db.transaction()` for
the first time (previously a bare sequence of unrelated statements against `db` directly), passing
`tx` through to the lock, the mutation, `revokeAllSessionsForUser`, and `recordAuthEvent` alike —
mirroring the exact `db.transaction(async (tx) => …)` + shared-query-function pattern already
established by `incidents/service.ts`'s `removeParticipant()`.

Proven with a genuine concurrency test in `security.integration.test.ts`: two real admins, two
`Promise.all`-fired concurrent `POST /users/:id/disable` requests, asserting exactly one `200` and
one `409` — never both `200`.

## HTTP security headers

`@fastify/helmet@13.1.1` added (Fastify v5-compatible, matching the existing `@fastify/*` v11
ecosystem already in use) — confirmed via full-codebase search that **zero** security headers
existed beforehand (no CSP, no `X-Content-Type-Options`, no `X-Frame-Options`, no
`Strict-Transport-Security`, no plugin registered at all). Configuration deliberately departs from
helmet's HTML-oriented defaults since this backend never serves HTML/JS itself (the frontend is a
separate Vite/nginx origin):

- `contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } }` — maximally strict is safe
  here; there is no inline script/style of this app's own to accommodate.
- `crossOriginResourcePolicy: { policy: "cross-origin" }` — helmet's default `same-origin` would
  fight the app's own deliberate cross-origin design (frontend `:5173` fetching this API's
  `:4000` origin with `credentials: true`, already documented in `app.ts`'s CORS comment).
- `hsts`: only when `env.nodeEnv === "production"` — forcing it under plain `http` in local dev
  would be a meaningless, confusing header (per the module spec's own explicit warning against
  "blindly" enabling HSTS for localhost).

## Production environment fail-fast

New `assertProductionEnvSafe()` (`config/env.ts`) throws if `NODE_ENV=production` and `CORS_ORIGIN`
was never explicitly set (it otherwise silently defaults to `http://localhost:5173`, which also
backs the WebSocket Origin check — one misconfiguration point affecting both). Called only from the
real process entrypoint (`index.ts`), never from `buildApp()`/`buildTestApp()`, so every existing
test's reliance on the development default is untouched. Follows the exact fail-fast-with-clear-
message-then-`process.exit(1)` pattern `loadMfaEncryptionKey()` already established.

## Cache-Control

A single global `onSend` hook sets `Cache-Control: no-store` on every response — this backend serves
no static/cacheable assets of its own, and essentially every response is either authenticated,
Guest-session-scoped, or a mutation result, none of which should sit in a browser back/forward cache
or a shared proxy.

## Reviewed and confirmed already-correct (no code change)

CSRF coverage (100% of 63 state-changing routes, audited individually), CORS/WebSocket-Origin
strictness, targeted rate limiting on login/OTP-request/OTP-verify/invitation-lookup (deliberately
not one blanket global limiter, matching the spec's own emergency-use warning), SQL-injection safety
(no raw SQL anywhere), XSS safety (no `dangerouslySetInnerHTML` anywhere), logging hygiene (Fastify's
default serializers never include headers/body), production error-response sanitization, frontend
storage (zero `localStorage`/`sessionStorage` usage — cookies only), secret-scan cleanliness, and
RBAC/IDOR coverage (every module's own test suite already systematically tests the
unauthenticated/no-permission/authorized matrix). Full detail and reasoning for each is in
[SECURITY_REVIEW.md](../../docs/security/SECURITY_REVIEW.md), "Reviewed, no gap found" — not
repeated here to avoid two documents drifting out of sync.

## Dependency review

`npm audit` (production): 2 moderate, both left unpatched with documented rationale (a transitive
`exceljs`→`uuid` finding requiring a breaking downgrade with low real-world exploitability for this
codebase's actual usage; a `drizzle-kit` devDependency-only chain with zero production exposure).
Frontend workspace: 0 findings. Full classification in SECURITY_REVIEW.md, "Dependency review."

## Tests

Backend: 607 total (up from 593) — 3 new/updated in `notifications/registry.test.ts`, 1 new in
`participants/guestParticipant.integration.test.ts`, and a new `security/security.integration.test.ts`
(11 tests: headers, cache-control, error sanitization, production env fail-fast ×2 directions,
provider fail-fast ×2, and the last-admin concurrency test). Frontend: 120 (unchanged). Database: 12
(unchanged) — no migration or seed change this module.

## Module boundaries

Modules 15/16 (Audio/Video, Screen Sharing) remain deferred — untouched. Module 27 (Provider
Configuration & Administration UI) remains unstarted — provider configuration stays
environment-driven; no admin-editable credential surface was introduced. Modules 24 (Testing), 25
(Docker Deployment), and 26 (Production Readiness) remain unstarted — deployment perimeter,
infrastructure hardening, and multi-node coordination are explicitly out of this module's scope (see
SECURITY_REVIEW.md, "Residual risks").
