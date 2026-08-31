# BEACON Security Review — Module 23

A systematic security review and hardening pass across Modules 00–22, performed as its own
numbered module rather than folded into feature work. This document is the durable record of that
review: the threat model, what was inspected, what was found, what was fixed, and what remains a
deliberately deferred residual risk. See [claude/prompts/23-security-hardening.md](../../claude/prompts/23-security-hardening.md)
for the module's own implementation log.

## Threat model

**Assets:** registered User accounts and credentials, Guest invitations and OTP challenges, Guest
sessions, Incident data (including CLOSED/historical), Contact PII (email/phone), Alert
destinations and content, Chat message content, War Room session/roster data, the Audit log,
Administration controls, notification provider credentials, and the database itself.

**Likely attackers, roughly in increasing trust:**
- An unauthenticated Internet attacker probing public endpoints (`/health`, guest invitation
  lookup, OTP request/verify, login).
- Someone who has obtained a Guest invitation link (stolen, forwarded, or guessed) but hasn't yet
  passed OTP verification.
- Someone who has compromised or is replaying a verified Guest session (stolen cookie).
- A low-privilege registered User (e.g. RESPONDER) attempting to reach data or actions outside
  their granted permissions.
- A malicious or compromised responder/manager attempting privilege escalation or cross-Incident
  access.
- Someone who has stolen a registered User's session cookie.
- An automated brute-force/credential-stuffing/bot client.
- An insider with legitimate but partial permissions attempting to exceed their intended scope.

**Trust boundaries:** the browser/Internet boundary (everything in `backend/src/modules/*/routes.ts`
and `publicRoutes.ts`); the registered-User vs. Guest authentication boundary (two entirely separate
cookie/session/CSRF pairs, `authenticateUser()` vs. `authenticateGuest()` — a Guest cookie is never
accepted by a registered-User route and vice versa); the RBAC permission boundary (`requirePermission()`);
the Incident-scope boundary (a Guest's or an Incident-scoped action's authority is confined to
exactly the Incident its invitation/session belongs to); and the provider boundary (SMS/Email
credentials live only in backend config, never reach the browser, never appear in a client response).

## Inventory of existing controls (as found, before this module)

| Area | State found |
|---|---|
| Password hashing | Argon2id, configurable cost parameters (Module 02) |
| Sessions | Server-side, hashed-token-only persistence, HttpOnly + SameSite=Lax cookies, `cookieSecure` production-aware |
| CSRF | Double-submit-cookie scheme (`requireCsrf`), a **separate, parallel** scheme for Guest routes (`requireGuestCsrf`) |
| MFA | TOTP + one-time recovery codes, encrypted-at-rest secret |
| Break-glass | Interactive-only bootstrap CLI, masked password entry, DB-unique-enforced single account, no default/known credential |
| Login throttling | Per-email lockout (Module 02) + per-IP rate limit (`@fastify/rate-limit`) |
| RBAC | Permission-code based (`requirePermission`), never hardcoded role checks (except documented last-admin/break-glass safeguards) |
| Guest isolation | Separate identity anchor (`guest_invitations`), separate session table, separate cookie/CSRF pair, capability + Incident-scope re-checked per route |
| WebSocket | Origin-header validation before upgrade (chat), per-connection send rate limiting, strict incoming-frame schema validation, backpressure-bounded broadcast |
| Notification providers | Provider abstraction, credentials server-side only, webhook signature verification (Twilio HMAC, SES/SNS RSA), idempotent dedupe |
| Audit | Append-only, `audit.read`-gated, safe metadata policy (no secrets/PII beyond intended fields) |
| Error handling | Generic client-facing 500s; `AuthError` carries a safe code/message only |
| DB integrity | Partial unique indexes enforcing single-break-glass, no-duplicate-active-invitation, exactly-one-active-participant-identity, etc. |

This was already a strong baseline. The review below focuses on what was **missing or wrong**, not
on re-praising what was already correct.

## Findings and fixes

### 1. Unknown notification provider silently fell back to mock (fixed — high priority, explicitly flagged)

`notifications/config.ts`'s `readSmsProvider`/`readEmailProvider` mapped *any* unrecognized
`SMS_PROVIDER`/`EMAIL_PROVIDER` value — including an operator typo like `twilio-typoo` — silently to
`"mock"`. The registry's own `default:` case (meant to fail fast on an unsupported provider) was
dead code, because by the time a value reached it, an invalid value had already been coerced away.
In production this could mean an operator believes real SMS/Email dispatch is configured when it is
silently a no-op mock, with zero error, zero warning, zero audit trail — a false sense of having a
working emergency notification channel.

**Fix:** both functions now distinguish "unset" (empty/undefined → default to mock, unchanged
behavior) from "set to an unrecognized value" (→ throw at config-load time, which is called eagerly
at application startup, so this fails the process before it ever accepts a request). Existing test
`registry.test.ts` was updated (its prior test explicitly asserted the old silent-fallback behavior
— now asserts the throw instead); two new tests cover both provider fields.

### 2. A removed Guest's already-open chat WebSocket could keep sending (fixed)

Removing a Guest participant revokes their session (future REST/WS-handshake requests are denied),
but does not proactively close a WebSocket connection opened *before* removal. The Guest-chat send
handler's authorization was a closure-captured snapshot from connection time
(`guest.capabilities.chat`), never re-checked per message, and `sendGuestMessage()` itself never
re-validated the participant's live status — so a removed Guest with a still-open socket could
continue sending chat messages indefinitely.

**Fix:** `sendGuestMessage()` now re-checks the participant's current `incident_participants` status
on every send and rejects (`403 guest_removed`) if it's no longer active — "message operations
revalidated promptly," per this module's own scope, rather than needing to proactively track and
force-close sockets. Verified end-to-end with a new WebSocket-level test in
`participants/guestParticipant.integration.test.ts`: connect while active, remove mid-connection,
attempt a send on the still-open socket, confirm rejection and that no message was persisted.

### 3. No HTTP security headers at all (fixed)

Confirmed via full-codebase search: no CSP, no `X-Content-Type-Options`, no `X-Frame-Options`, no
`Referrer-Policy`, no HSTS — `@fastify/helmet` wasn't even a dependency. Every other Fastify
ecosystem plugin already in use (`cors`, `rate-limit`, `cookie`) had a headers-hardening counterpart
missing.

**Fix:** added `@fastify/helmet` (the standard first-party Fastify plugin, consistent with the
existing ecosystem choices) with: `Content-Security-Policy: default-src 'none'` (safe and maximal
since this backend never serves HTML/JS of its own — the frontend is a separate Vite/nginx origin),
`Cross-Origin-Resource-Policy: cross-origin` (deliberately relaxed from helmet's `same-origin`
default, since this API is designed to be fetched cross-origin by the frontend), and
`Strict-Transport-Security` gated on `NODE_ENV === "production"` (meaningless, and disabled, under
plain http in local dev). New tests assert the headers are present and that HSTS is
environment-aware.

### 4. `CORS_ORIGIN` silently defaults to `localhost:5173` with no production guard (fixed)

A production deployment that forgot to set `CORS_ORIGIN` would boot successfully with CORS (and,
since chat's WebSocket Origin check reuses the same value, WS handshake validation) locked to a
value that can never match any real frontend — a live misconfiguration with no fail-fast signal.

**Fix:** a new `assertProductionEnvSafe()` (in `config/env.ts`), called only from the real startup
entrypoint (`index.ts`, not `buildApp()`/tests), throws if `NODE_ENV=production` and `CORS_ORIGIN`
was not explicitly set. Follows the exact existing fail-fast pattern already established by
`loadMfaEncryptionKey()`.

### 5. Last-admin safeguard had a genuine TOCTOU race under concurrent requests (fixed)

`assertNotLastActiveAdmin()` was a plain, unlocked "count active admins excluding this one" read
with no transaction, no row locking. With exactly two active admins A and B, two concurrent
requests — one disabling A, one disabling B — could both read "1 remaining" before either commits,
and both proceed, leaving zero active admins. `disableUser()` and `removeRole()` were not wrapped in
a database transaction at all.

**Fix:** both call sites now wrap their check-and-act sequence in `db.transaction()`.
`assertNotLastActiveAdmin()` locks the candidate admin `users` rows with `SELECT ... FOR UPDATE`
before counting (Postgres rejects `FOR UPDATE` combined directly with the existing `DISTINCT` join
query, so the row set is first identified, then locked in a second, targeted query) — two
overlapping-row-set transactions now serialize on that lock instead of racing. Verified with a new
concurrency test that fires two genuinely concurrent `POST /users/:id/disable` requests against two
admins and asserts exactly one `200`/one `409`, never both `200`.

### 6. No `Cache-Control` policy on any response (fixed)

This backend serves no static/cacheable assets and nearly every response is either authenticated,
Guest-session-scoped, or a mutation result — none of it should be retained by a browser
back/forward cache or a shared proxy.

**Fix:** a global `onSend` hook sets `Cache-Control: no-store` on every response. Zero cost, since
there is nothing here that benefits from caching.

## Reviewed, no gap found

- **CSRF coverage** — audited every `app.post/patch/put/delete` registration across all 13 backend
  route files (63 state-changing routes): 100% call `requireCsrf`/`requireGuestCsrf` as their first
  statement, except the intentionally-exempt pre-session bootstrap routes (login, Guest OTP
  request/verify — no session exists yet to protect) and the webhook routes (provider-signature
  verification instead, documented at the call site).
- **CORS** — a strict single-origin allowlist (never a wildcard; `credentials: true` forbids one
  anyway), never a hardcoded-localhost value reaching production undetected (see finding 4).
- **WebSocket Origin** — validated before authentication/upgrade on both chat WS routes; a
  mismatched/missing Origin is rejected outright (the WebSocket-equivalent of CSRF protection, since
  normal CORS preflight doesn't cover the handshake).
- **Rate limiting** — login, Guest OTP request, Guest OTP verify, and the public Guest
  invitation-token lookup each have their own targeted per-IP rate limit (not one blanket global
  limiter, which the module spec explicitly warns against for emergency-use reasons). MFA
  verification rides on login's limit since it's the same request. Chat has its own independent
  per-connection sliding-window send limit (15/10s) plus a strict incoming-frame schema check and a
  backpressure-bounded broadcast.
- **SQL injection** — no `sql.raw` usage anywhere in the codebase; every dynamic query uses Drizzle's
  parameterized query builder or tagged-template `sql` helper with column/table references, never
  raw string concatenation of user input. Spot-checked search/filter/sort paths (contacts, incidents)
  confirm no user-controlled column-name or raw-fragment construction.
- **XSS** — `dangerouslySetInnerHTML`/`innerHTML =` appear nowhere in the frontend (confirmed by
  full-codebase search); React's default escaping is relied on everywhere, including Chat message
  bodies, Incident/Alert/Template content, and Guest display names.
- **Logging** — Fastify's default request/response serializers (used as-is, `logger: true`) only
  ever log method/url/host/remoteAddress and status code, never headers or body. A full-codebase
  search for any log call referencing `password`/`token`/`secret`/`cookie`/`headers`/`body` found
  none.
- **Production error sanitization** — the single global error handler (`app.ts`) returns a generic
  `{error:"internal_error", message:"Something went wrong..."}` for any non-`AuthError`, unchanged
  across environments; only `AuthError`'s own deliberately-safe code/message ever reaches the client
  otherwise.
- **Frontend storage** — zero uses of `localStorage`/`sessionStorage`/`indexedDB` anywhere in the
  frontend (confirmed by full-codebase search). Authentication is entirely cookie-based, as
  intended.
- **Secrets** — `.env`/`.env.*` are gitignored (with an explicit `.env.example` exception carve-out).
  A full tracked-file scan for AWS/Twilio/GitHub/OpenAI/Slack-shaped token patterns and PEM private
  key headers found nothing.
- **RBAC / IDOR / privilege escalation** — every module's own test suite already systematically
  covers "unauthenticated denied → no-permission denied → authorized succeeds" for its routes (a
  convention established since Module 02 and followed with zero exceptions found across ~40 test
  files); Incident-commander authority is never treated as global (confirmed: Command Center,
  Administration, and Audit permissions are entirely separate permission codes, none implied by
  `incidents.commander.assign`). Cross-Incident isolation is explicitly tested for Guest Chat, Guest
  War Room, and participant management ("Incident scope isolation" tests in Module 19's suite).
- **War Room Guest access** — every join/leave action is a discrete, freshly-`authenticateGuest()`-ed
  HTTP request (no persistent connection like chat's), so a removed Guest's revoked session is
  already re-checked on the very next action — no equivalent to finding 2 exists here.
- **DB integrity constraints** — spot-checked and confirmed already enforced: single break-glass
  account (`users_single_break_glass_idx`), no duplicate role assignment (`user_roles_user_role_idx`,
  observed directly via a real constraint-violation error during this module's own test debugging),
  no duplicate active Guest invitation per destination per Incident, exactly-one-active-participant
  identity. No new constraint was added — none was found missing.

## Dependency review

`npm audit` (production dependencies): 2 moderate findings, both transitive and both requiring a
breaking downgrade to resolve, which was **not** applied:

- `uuid <11.1.1` (via `exceljs`, Module 05's XLSX import) — a buffer-bounds-check advisory affecting
  `uuid.v3/v5/v6` **only when a pre-allocated buffer is explicitly supplied by the caller**. BEACON's
  own code never calls `uuid` directly; `exceljs` uses it internally for its own document-part IDs,
  not in a way influenced by an uploaded file's content. Classified: transitive, low real-world
  exploitability for this codebase's actual usage. The only available fix is `exceljs@3.4.0`, a
  major breaking downgrade that risks reintroducing other already-fixed `exceljs` bugs — not applied.
- `drizzle-kit → @esbuild-kit/esm-loader → esbuild` (dev server request/response exposure) —
  entirely a **devDependency** chain. `drizzle-kit` is a local migration-generation CLI, never
  bundled, shipped, or run in any deployed environment; the advisory only matters when esbuild's own
  dev server is actually running and network-exposed, which never happens in this project's usage.
  Classified: dev-only, zero production exposure.

Frontend workspace: 0 findings (`npm audit` clean).

## Residual risks — deliberately not "fixed" here

Per this module's own scope boundary, none of the following were touched:

- **Process-local WebSocket broadcast and process-local rate limiting** — both the chat connection
  registry and `@fastify/rate-limit`'s default store are in-memory and per-process. A multi-instance
  deployment would need a shared pub/sub layer (e.g. Redis) to coordinate across processes — a known,
  already-documented (Module 13) limitation, not something Module 23 introduces new infrastructure
  to solve.
- **No RTC/media** — Modules 15/16 remain deferred; nothing here required or added any RTC provider
  dependency.
- **No deployment perimeter / WAF** — reverse proxy, TLS termination, network-level protections, and
  infrastructure hardening belong to Modules 25/26.
- **Audit/PII retention governance** — how long Audit events or Guest/Contact data are retained is
  not defined by this module; that's a policy decision for a later module, not a code change here.
- **Provider configuration remains environment-driven** — no admin-editable provider credential UI
  was added; that boundary belongs to Module 27, unchanged by this review.
- **The two moderate dependency findings above** — documented, not patched, for the reasons given.

## Test coverage added this module

- `backend/src/test/notifications/registry.test.ts` — updated (1 test's expected behavior reversed
  to match the new fail-fast fix) + 2 new tests for both provider fields' fail-fast behavior.
- `backend/src/test/participants/guestParticipant.integration.test.ts` — 1 new end-to-end WebSocket
  test for finding 2.
- `backend/src/test/security/security.integration.test.ts` — new file, 11 tests: security headers
  presence/environment-awareness, `Cache-Control: no-store`, generic-error-response sanity,
  production `CORS_ORIGIN` fail-fast (both directions), provider fail-fast (duplicated here for
  visibility alongside the other cross-cutting checks), and the last-admin concurrency test.

Backend total: 607 (up from 593 after Module 22). Frontend: 120 (unchanged — no frontend changes
this module). Database: 12 (unchanged).

## Live validation

Curl/inject-driven checks against the live dev backend: `GET /health` unauthenticated returns a
minimal, safe body with `Cache-Control: no-store` and the new security headers present; `GET
/admin/status` unauthenticated returns `401` with no internal detail; a request with an
`SMS_PROVIDER=twilio-typo` environment override fails the process at startup rather than booting
silently into mock mode (verified via `loadNotificationConfig` throwing, exercised in the automated
suite rather than a separate manual boot — starting a second real process against a shared dev
database purely to observe a startup crash was judged unnecessary given the automated test already
proves the exact code path). Full details of the interactive browser walkthrough (Administration
access boundaries, admin-privileged actions) were already covered during Module 22's own live
validation and were not re-run here since Module 23 did not change that surface.
