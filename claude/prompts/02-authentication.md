# Module 02 — Authentication

## Scope

Local, self-contained BEACON authentication that works with no dependency on any enterprise identity system (AD, Entra, Okta, LDAP, Microsoft 365, VPN). Covers: password login (Argon2id), server-side opaque-token sessions, TOTP MFA with recovery codes, a local emergency break-glass account, login throttling, CSRF protection, authentication audit events, a safe bootstrap CLI, and the minimum frontend UI to log in, complete MFA, and log out. Authorization/RBAC (Module 03), contact/group/guest features, and business workflows are explicitly out of scope.

## Package structure

```
backend/src/modules/auth/
  config.ts          Env-driven config (session TTL, Argon2 params, MFA issuer, throttle limits)
  password.ts         Argon2id hash/verify + a timing-safe "dummy hash" for unknown-user logins
  passwordPolicy.ts   Minimum length + common-password/identity-match rejection
  session.ts           Opaque token generate/hash, create/find/revoke against the sessions table
  totp.ts              TOTP secret generate/verify, AES-256-GCM encryption at rest, otpauth URI
  recoveryCodes.ts     Hashed one-time recovery codes, generate/consume/regenerate
  loginThrottle.ts     In-process per-email failure tracking (brute-force protection)
  csrf.ts               Double-submit-cookie CSRF token issue/check
  audit.ts              Typed wrapper around audit_logs for auth events
  errors.ts             AuthError + generic, safe error responses
  userAuth.ts            User/MFA-credential lookup helpers
  plugin.ts              createAuthenticateHook — the reusable session-validation preHandler
  routes.ts              All /auth/* route handlers
  types.ts                AuthenticatedUser + Fastify request augmentation
backend/scripts/bootstrap-user.ts   Interactive CLI to create a user (incl. break-glass)
frontend/src/lib/api.ts             fetch wrapper: credentials + CSRF header injection
frontend/src/auth/                  AuthProvider/useAuth context, LoginPage (+ MFA step)
database/src/schema/{sessions,mfaCredentials,mfaRecoveryCodes}.ts   New tables
database/src/schema/users.ts        + is_break_glass column and partial unique index
```

## Session design

- **Opaque bearer token in an HttpOnly cookie** (`beacon_session`), not a JWT — nothing about the session is client-readable or forgeable, and revocation is immediate (no token to wait out).
- The **raw token is never persisted** — only `sha256(token)` is stored in `sessions.token_hash` (unique). A database read alone cannot reconstitute a valid session.
- **One reusable connection pool** is used throughout (`@beacon/database`'s `getDb()`), never a new connection per request — unchanged from Module 01.
- **A successful login always creates a brand-new session row** — there is no pre-auth session to "upgrade," so session fixation isn't reachable by this design.
- Cookie flags: `HttpOnly`, `SameSite=Lax`, `Secure` when `NODE_ENV=production`, `Path=/`, `Max-Age` from `SESSION_TTL_HOURS` (default 12h).
- **Validation** (`plugin.ts`): hash the cookie token, look up an unrevoked, unexpired row, load the user, reject if the user is inactive/deleted — all in one preHandler, reusable by any future protected route. It does not evaluate permissions (Module 03).
- **Logout** sets `revoked_at`; the session row is retained (not deleted) for audit continuity, and is opportunistically pruned once the row is 30+ days past expiry/revocation (a light `DELETE` on every new login — best-effort, never fails the login itself). No cron/scheduler was introduced for this; a proper scheduled cleanup job is a reasonable future improvement, not required at this scale.

## CSRF approach

Double-submit cookie: a second, **readable** (non-HttpOnly) cookie (`beacon_csrf`) is issued alongside the session cookie at login. The frontend reads it from `document.cookie` and echoes it back as an `x-csrf-token` header on every state-changing authenticated request (logout, MFA enroll/confirm/disable, recovery-code regeneration). A cross-site page cannot read another origin's cookie to construct that header, even though the browser still attaches the cookie itself automatically — that mismatch is exactly what's checked (`csrf.ts`'s `requireCsrf`, constant-time compared). `/auth/login` itself is not CSRF-gated (there is no session yet to protect); it relies on rate limiting plus the fact that an attacker still needs the real password. `SameSite=Lax` on both cookies is the baseline defense underneath this — it was not relaxed for convenience anywhere.

## MFA approach (TOTP)

- **Enrollment is two steps**, matching the routes: `POST /auth/mfa/enroll` generates a secret (`status: 'pending'`) and returns the base32 secret + `otpauth://` URI **once**; `POST /auth/mfa/enroll/confirm` requires a valid code against that pending secret before flipping it to `status: 'active'` and issuing 10 recovery codes (also shown **once**).
- **Secrets are encrypted at rest**, not hashed — TOTP verification requires the raw secret (unlike a password), so `mfa_credentials.secret_ciphertext` holds AES-256-GCM(iv ‖ authTag ‖ ciphertext), keyed by `MFA_ENCRYPTION_KEY` (32 random bytes, base64, required at startup — same fail-fast pattern as `DATABASE_URL`). The encrypted value is never returned by any endpoint after enrollment completes.
- **Login with MFA is a single request**, not a two-request "pending session" flow: the client submits `email` + `password` + (`totp` or `recoveryCode`) together. If a user has an active credential and neither is supplied, the server responds `401 mfa_required` **without creating any session or server-side pending state** — there was nothing to leave lying around. This keeps the design simpler than a stateful "partial login" token while still fully supporting the two-screen UI (password screen → code screen) on the frontend, since the frontend just resubmits everything on the second screen.
- **Recovery codes** are 10 codes of 64 bits of entropy each (`xxxx-xxxx-xxxx-xxxx`, hex), shown in plaintext exactly once, stored only as `sha256(code)`. Consuming one sets `used_at` — a used or unknown code fails identically. Regenerating deletes the entire old batch before inserting the new one, so old codes stop working immediately (verified live).
- **Disabling MFA or regenerating recovery codes both require re-entering the current password** in the same request — the existing session alone isn't sufficient for these particular changes.

## Break-glass approach

- A `users.is_break_glass` boolean, with a **partial unique index** (`WHERE is_break_glass = true`) — the database itself guarantees at most one such account can ever exist, independent of any application-level check.
- Created exclusively through `backend/scripts/bootstrap-user.ts` (same tool used for any local dev user), which also refuses to proceed if a break-glass account already exists.
- **No MFA at creation time** — the account cannot enroll MFA before it exists or before its first login, so bootstrap necessarily creates it password-only. This is the documented "emergency initialization" gap the spec allows for: the script's own output explicitly instructs the operator to log in and complete MFA enrollment (`POST /auth/mfa/enroll` → `/auth/mfa/enroll/confirm`) immediately afterward. Login logic itself has no break-glass special-casing — once MFA is enrolled, it's enforced identically to any other account, which keeps the authentication path uniform and auditable rather than carrying a permanent bypass.
- Every login by this account emits both `LOGIN_SUCCESS` and a dedicated `BREAK_GLASS_LOGIN` audit event, so its use is always independently visible in `audit_logs`.
- No default/hardcoded password exists anywhere in source; the bootstrap script only accepts a password typed interactively (masked when run in a real terminal) — never a CLI argument or environment variable, so it can't land in shell history or process listings.

## Other security decisions

- **No user enumeration**: unknown email, wrong password, and inactive/deleted user all return the exact same `401 { error: "invalid_credentials", message: "Invalid email or password." }`. An unknown email still runs a real Argon2 verify against a precomputed dummy hash (`getDummyHash`), so response timing doesn't distinguish "no such user" from "wrong password."
- **Two independent throttle layers**: `@fastify/rate-limit` (IP-based, in-memory, `LOGIN_RATE_LIMIT_MAX`/`LOGIN_RATE_LIMIT_WINDOW`) guards against raw request floods; a hand-rolled per-normalized-email `LoginThrottle` (in-process `Map`, `LOGIN_MAX_FAILURES`/`LOGIN_LOCKOUT_WINDOW_MINUTES`) guards against slow, distributed credential stuffing against one account. The per-email lock applies identically whether or not the email is real, so its distinct "too many attempts" message doesn't leak account existence. **Both are single-process, in-memory stores** — this matches the current single-instance modular monolith; a horizontally-scaled deployment would need a shared store (e.g. Redis) for either layer to stay effective across instances. This is a known, documented limitation, not a gap introduced silently.
- **Temporary throttling, not permanent lockout** — the per-email lock always expires after `LOGIN_LOCKOUT_WINDOW_MINUTES`; there is no mechanism by which a remote attacker can permanently disable another user's account by repeatedly failing their password.
- **No plaintext secrets stored anywhere**: passwords are Argon2id-only; TOTP secrets are encrypted (not reversible without the server key, but also never stored plaintext); recovery codes and session tokens are SHA-256 hashed. Verified directly against the live database in the integration tests, not just asserted in unit tests.
- **CORS**: `@fastify/cors` is registered with an explicit origin allow-list (`CORS_ORIGIN`, default `http://localhost:5173`) and `credentials: true` — required because the frontend dev server and backend run on different ports/origins locally, and cookies need `credentials: true` to cross that boundary; a wildcard origin is rejected by the CORS spec once credentials are enabled, so this could not have been "just allow everything" even by accident.
- **Safe errors everywhere**: a global Fastify error handler (`app.ts`) maps `AuthError` to its typed response, request-validation failures to a generic `invalid_request`, and anything unexpected to a generic `internal_error` with the real error only logged server-side — no stack traces, DB errors, or crypto internals ever reach the client.

## Acceptance criteria

- [x] A. Local password authentication works — live-verified against `beacon_dev`.
- [x] B. Passwords use Argon2id — `@node-rs/argon2`, `Algorithm.Argon2id`, configurable cost params.
- [x] C. Plaintext passwords are never stored — verified live against the `users` row (`$argon2id$` prefix, not the input).
- [x] D. Secure server-side sessions work — HttpOnly/SameSite=Lax cookie, hashed token storage, verified live.
- [x] E. Login/logout/me endpoints work — all three live-verified via curl and the real frontend.
- [x] F. Sessions expire/revoke correctly — expiry checked in the validation query; logout sets `revoked_at` and immediately invalidates (live-verified).
- [x] G. Inactive users cannot authenticate — `isUsableAccount()` check, same generic error as any other failure.
- [x] H. Login failures do not reveal whether user exists — identical error for unknown-user/wrong-password/inactive, timing-normalized via the dummy hash.
- [x] I. Practical brute-force protection is present — IP rate limit + per-email throttle, both live/unit-tested.
- [x] J. TOTP MFA works — enrollment, confirmation, and login verification all live-tested end-to-end.
- [x] K. MFA secrets are handled securely — AES-256-GCM at rest, never returned after enrollment, never logged.
- [x] L. Recovery codes are one-time and stored hashed — live-verified: reuse fails, regeneration invalidates the old batch.
- [x] M. Break-glass local account bootstrap is supported securely — DB-enforced single-account constraint (live-verified: a second insert throws), interactive-only credential entry, no default password.
- [x] N. Authentication does not depend on enterprise identity systems — no AD/Entra/Okta/LDAP/M365 integration exists anywhere in this module.
- [x] O. Cookie/CSRF protections are implemented appropriately — HttpOnly + SameSite=Lax + double-submit CSRF, live-verified (missing header → 403).
- [x] P. Authentication audit events are recorded without secrets — all 9 event types verified live against `audit_logs`; metadata scanned for secret patterns in tests.
- [x] Q. Frontend login/MFA/logout flow works — verified in a real browser against the real backend (see Live PostgreSQL validation).
- [x] R. Database migration succeeds on `beacon_dev` — `0002_living_silver_samurai.sql` applied live.
- [x] S. Lint passes (frontend, backend, database).
- [x] T. Typecheck passes (frontend, backend incl. `scripts/`, database — strict mode).
- [x] U. Tests pass — 80 total (frontend 6, backend 62 incl. 22 live-DB integration tests, database 12).
- [x] V. Production build passes (database, backend, frontend).
- [x] W. Stakeholder prototype unchanged.
- [x] X. No secrets committed — `.env` git-ignored; `.env.example` carries placeholders only; diff scanned before commit.
- [x] Y. No Module 03+ authorization behavior implemented — `authenticate` preHandler answers only "is this a valid session for a usable user," never a permission question.

## Validation performed

- `npm install` (added `@node-rs/argon2`, `otpauth`, `@fastify/cookie`, `@fastify/cors`, `@fastify/rate-limit`, `dotenv-cli` to backend).
- `npm run db:generate` / `db:migrate` — migration `0002_living_silver_samurai.sql` (sessions, mfa_credentials, mfa_recovery_codes, users.is_break_glass + partial unique index) applied to `beacon_dev`.
- `npm run lint`, `npm run typecheck`, `npm run build` — clean across `frontend`, `backend`, `database`.
- `npm run test` — full suite green: frontend (App + LoginPage), backend (password/passwordPolicy/totp/loginThrottle/session/csrf/recoveryCodes unit tests, plus a live-database integration suite covering login success/failure/unknown-user/inactive-user, session creation/rejection, logout+CSRF, per-email throttling, full MFA enrollment→login→recovery-code→regenerate→disable lifecycle, break-glass DB constraint, and an audit-log secret-leak scan), database (schema/config/migration tests).
- **Live validation against `beacon_dev`** (native PostgreSQL 18, `DATABASE_URL` never displayed): created a demo user via the auth module's own password/policy code, ran the full login → `/auth/me` → CSRF-rejected-logout → CSRF-accepted-logout → session-invalidated-me sequence via `curl`, then repeated login/logout through the **actual React frontend in a real browser** against the actual running backend (screenshots not needed — verified via DOM text, network requests, and console). The demo user and its session were deleted afterward, leaving `beacon_dev` in the same state as before validation.
- Security review pass — see below.

## Defects found and fixed during this module

1. **CORS was entirely unconfigured.** The frontend dev server (`:5173`) and backend (`:4000`) are different origins locally; without `@fastify/cors`, the browser blocked every credentialed cross-origin request outright (login never reached the network). Fixed by registering `@fastify/cors` with an explicit origin allow-list and `credentials: true`; added `CORS_ORIGIN` to `.env.example`/`.env`/`docker-compose.yml`. Caught only by testing the real frontend in a real browser — `curl` and Fastify's `inject()` never exercise same-origin-policy enforcement, so this class of bug is invisible to API-level testing alone.
2. **Frontend tests leaked DOM between tests within the same file.** `@testing-library/react`'s automatic cleanup only self-registers when the test runner exposes `afterEach` as a global; this project's `vitest.config.ts` doesn't set `test.globals: true`, so nothing was cleaning up between tests, and a second `render()` in the same file accumulated on top of the first. Fixed by explicitly calling `cleanup()` in `afterEach` in `frontend/src/test/setup.ts`. Latent since Module 00 (undetected because `App.test.tsx` only ever had one test); surfaced once this module added a second render in the same file.
3. **`consumeRecoveryCode` had a check-then-act race condition.** It originally did a `SELECT ... WHERE used_at IS NULL` followed by a separate `UPDATE`; two concurrent requests submitting the same valid, unused code could both pass the `SELECT` before either `UPDATE` committed, double-spending a one-time code. Found during the explicit security review pass (item 20), fixed by collapsing it into a single atomic `UPDATE ... WHERE used_at IS NULL RETURNING id` — Postgres serializes the row update, so only the first concurrent caller can ever succeed. Covered by a dedicated `Promise.all` concurrency test against `beacon_dev`.
4. **`bootstrap-user.ts`'s non-interactive (piped-stdin) fallback hung after the first prompt.** Root cause: on this Windows/Node 24 environment, when an entire piped input is delivered to a process as one pre-buffered chunk (as a shell pipe does), a **second** `readline/promises` `question()` call on a **newly created** `readline.Interface` over the same already-partially-consumed `stdin` stream never resolves — a platform/Node quirk, reproduced in isolation and confirmed unrelated to this script's logic (a `child_process.spawn` driver writing lines with small delays between them works correctly with the *same* readline code). Fixed by having the non-interactive fallback reuse the **one** `readline.Interface` created for the earlier visible prompts instead of creating a new one per prompt. This only affects the piped/scripted-input fallback; the real interactive-terminal path (raw-mode masked password entry) was unaffected and is the flow an operator actually uses.

## Environment configuration added (`.env.example`)

`SESSION_TTL_HOURS`, `ARGON2_MEMORY_COST`/`ARGON2_TIME_COST`/`ARGON2_PARALLELISM`, `MFA_ISSUER`, `MFA_ENCRYPTION_KEY` (placeholder only, with the exact generation command in a comment), `PASSWORD_MIN_LENGTH`, `LOGIN_MAX_FAILURES`/`LOGIN_LOCKOUT_WINDOW_MINUTES`, `LOGIN_RATE_LIMIT_MAX`/`LOGIN_RATE_LIMIT_WINDOW`, `CORS_ORIGIN`. No real secrets in any committed file.

## Operational note: creating the break-glass account

1. `npm run bootstrap-user --workspace backend`, answer "y" to the break-glass question, choose a strong password (policy-enforced, ≥`PASSWORD_MIN_LENGTH`).
2. Log in immediately with that account.
3. `POST /auth/mfa/enroll`, scan/enter the secret in an authenticator app, `POST /auth/mfa/enroll/confirm` with the resulting code.
4. Store the returned recovery codes somewhere safe outside the repository — they are shown exactly once.

Until step 3 is complete, the break-glass account is password-only; treat that window as the sensitive part of the process.
