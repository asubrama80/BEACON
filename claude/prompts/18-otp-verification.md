# Module 18 — OTP Verification

## Scope

Two-factor possession-and-control verification for a Guest invitation: OTP challenge generation,
hashing, expiry, attempt-limiting, resend, a temporary Guest session distinct from registered-User
sessions, and the `authenticateGuest()` middleware that other modules (Module 19) will build on.
Does **not** implement Chat/War Room integration for a verified Guest — that is Module 19's job.

## Possession vs. control

The invitation link (Module 17's raw token) proves the holder *possesses* the link; the OTP proves
they also *control* the invited destination (email/phone). Both are required — `verifyOtp()`
re-validates the invitation's own state (not revoked, not expired, Incident not CLOSED) on every
call, never treating the token alone as sufficient authentication.

## OTP generation

`generateOtp()` (`otp.ts`) uses `node:crypto`'s `randomInt(0, 1_000_000)` — CSPRNG-backed, never
`Math.random()`. Never the prototype's static demo value (`482615`); `otp.test.ts` asserts that
literal string never appears across many generated codes, encoding the rule directly as a test.

## OTP storage

Never plaintext. `guest_otp_challenges.code_hash` is `sha256(salt:code)`, with a fresh random
`code_salt` per challenge — mirrors this codebase's session-token hashing pattern in spirit, using
a salted hash instead of a bare hash specifically because a 6-digit code's tiny keyspace makes a
per-challenge salt cheap insurance against hash-based enumeration if the table were ever exfiltrated
alongside the salts (unlikely to matter much in practice given the TTL/attempt-limit/lockout
defenses below are the real protection, but costs nothing to add).

## Dedicated challenge table (not a column on `guest_invitations`)

`guest_invitations.otp_hash` already existed (Module 01) but only fits a single current value —
insufficient for tracking attempt count, issued-at, consumed-at, and multiple historical challenges
per invitation (needed for resend semantics). `guest_otp_challenges` is the dedicated table the
module spec anticipated; the old unused `otp_hash` column on `guest_invitations` was left alone
(not removed) — a schema cleanup, not part of this module's actual scope.

## Expiry and attempts

`GUEST_OTP_TTL_MINUTES` (default 10) computed into a stored `expires_at`, server-enforced —
`verifyOtp()` checks it explicitly rather than trusting `findActiveChallenge()`'s status column
alone. `GUEST_OTP_MAX_ATTEMPTS` (default 5): each wrong code increments `attempt_count`; hitting the
limit transitions `status` to `locked` in the same call — even the *correct* code is then rejected
(live/test-verified) until a fresh OTP is requested. No expected-code disclosure in any error
response at any point.

## Resend

`GUEST_OTP_RESEND_COOLDOWN_SECONDS` (default 60) is enforced by comparing the active challenge's
`issued_at` against now — a resend within the cooldown gets `429 otp_resend_too_soon`. A successful
resend runs `supersedeActiveChallenges()` (old row → `superseded`) and `insertChallenge()` (new row
→ `active`) inside one transaction — the partial unique index `guest_otp_challenges_active_idx`
(`WHERE status = 'active'`) is the real race-safety guarantee for two concurrent resend requests,
not just the transaction ordering. Test-verified: the old code is rejected (checked against the new
challenge's hash, so it fails as `otp_invalid` — a genuine wrong-code result, not a fabricated
"expired" one) and the new code succeeds.

## One-time use and concurrent verification

A challenge is consumed via a conditional `UPDATE ... WHERE status = 'active'` — only one caller can
ever win that update. A second, later verify of an already-consumed code correctly fails
(`otp_expired`, since `findActiveChallenge()` finds nothing once consumed). For two genuinely
**concurrent** correct submissions (e.g. two browser tabs), the loser of the `consumeChallenge()`
race checks whether the challenge is now `consumed` (not locked/expired/superseded for some other
reason) and, if so, proceeds anyway — both legitimate concurrent callers get a session, since both
independently proved knowledge of the correct code. This does not violate "never issue multiple
independent guest identities": there is only one identity here (the `guest_invitations` row itself,
per Module 17's identity-model decision) — a session is just an access token to that one identity,
exactly like a registered User can hold multiple concurrent login sessions. What must happen exactly
once is the **state transition** (`verified_at` set, `GUEST_VERIFIED` timeline event) — guaranteed
by `markInvitationVerified()`'s own conditional `WHERE status NOT IN ('verified','joined')` update,
independent of which caller won the challenge-consume race. Live/test-verified via two
`Promise.all`-fired concurrent verify calls: both can succeed, but exactly one `GUEST_VERIFIED`
timeline event is ever recorded.

## Re-authentication after session expiry

Neither `requestOtp()` nor `verifyOtp()` reject an invitation whose status is already
`verified`/`joined` — a deliberate choice, not an oversight. Rejecting would create a dead end: a
Guest whose session cookie has expired (or who logs out and wants back in) would have no
self-service path to a new session, since re-requesting an OTP would be blocked by their own prior
success. Allowing it means `markInvitationVerified()`'s conditional update simply becomes a no-op on
a repeat verification (returns `false`), which is exactly why the `GUEST_VERIFIED` timeline event is
gated on that return value rather than firing unconditionally — the timeline stays a one-time
"first verified" record while the Guest can still always get back in.

## Guest session

`guest_sessions` — deliberately separate from `sessions` (registered-User auth), with no `user_id`
column at all. Token generation/hashing (`guestSessionToken.ts`) is a byte-for-byte mirror of
`auth/session.ts`'s pattern (`randomBytes(32)` + SHA-256), but a wholly separate token space — a
Guest session token is never valid against `authenticateUser()`, and a User session token is never
valid against `authenticateGuest()` (test-verified both directions). Cookie: `beacon_guest_session`,
HttpOnly, `SameSite=Lax`, `Secure` in production (reuses `AuthConfig.cookieSecure` rather than
re-deriving the same `NODE_ENV` check a second time). `GUEST_SESSION_TTL_HOURS` (default 12) is an
absolute cap, independent of activity.

## Guest CSRF

A second, wholly separate double-submit-cookie pair (`beacon_guest_csrf` / `x-guest-csrf-token`),
issued alongside the session cookie the moment OTP verification succeeds — set up now even though
this module's only Guest mutation is logout, so Module 19's Guest Chat-send/War-Room-join mutations
have CSRF protection available from day one rather than needing a retrofit.

## `authenticateGuest()`

`guestAuth.ts` — the Guest-equivalent of `auth/plugin.ts`'s `createAuthenticateHook()`, and
entirely separate from it; `authenticateUser()` is untouched by this module. Re-validates on
**every** call, not just at cookie-issue time: session must be unexpired/unrevoked, the invitation
must be unrevoked, and the Incident must not be CLOSED — so an existing Guest session is denied the
instant any of those change mid-cookie-lifetime, never relying on cookie expiry alone
(live/test-verified: closing the Incident immediately denies a previously-valid session).
`request.authGuest` carries only `{guestInvitationId, guestSessionId, incidentId, guestName,
capabilities}` — no RBAC role, no global permission, no destination.

## APIs

Public, no session, no CSRF (there is no session yet), rate-limited both per-invitation (cooldown/
attempt-lockout, the primary brute-force defense) and per-IP (secondary layer, configurable —
`GUEST_OTP_REQUEST_RATE_LIMIT_MAX`/`GUEST_OTP_VERIFY_RATE_LIMIT_MAX`, mirroring
`LOGIN_RATE_LIMIT_MAX`'s existing test-override pattern):

- `POST /guest/invitations/:token/otp/request` — returns `{maskedDestination, resendAvailableAt,
  otpExpiresAt}` only, never the code.
- `POST /guest/invitations/:token/otp/verify` — body `{code}`; on success sets the Guest
  session+CSRF cookies and returns `{guestName, incidentId, sessionExpiresAt}`.

Guest-session-authenticated (`authenticateGuest()`):
- `GET /guest/session` — returns the safe scoped context.
- `POST /guest/session/logout` — Guest-CSRF-required; revokes the session and clears both cookies.

## Test-only OTP capture (never a DEV API endpoint)

The module spec explicitly disfavors a DEV-only OTP-retrieval endpoint ("prefer test harness
instead"). `RequestOtpOptions.onOtpGenerated` is an optional callback threaded through
`buildApp()`/`buildTestApp()` — the exact same shape as the already-established `sesFetchCert`
test-only injection seam from Module 11. It is invoked with the raw code immediately after
generation, purely in-process; nothing reachable over HTTP ever exposes it, and it is `undefined` on
every production code path (`buildApp()` is only ever called with it set from `buildTestApp()`).

## Frontend

`GuestLandingPage.tsx` (Module 17's public-route component) now owns the full flow: possession-link
validation → "Begin Verification" → OTP request → "Code sent to {masked}" + 6-digit entry → verify
→ authenticated confirmation, with inline retryable errors for a wrong/expired/locked code and a
full-page terminal state for a revoked/expired invitation or a CLOSED Incident. On mount, it first
checks `GET /guest/session` — an already-valid session short-circuits straight to the authenticated
view, so a browser refresh does not force the Guest through the flow again
(live/test-verified). No password field, no account-registration UI anywhere in this flow.

## Audit and timeline

Audit: `GUEST_OTP_REQUESTED`, `GUEST_VERIFICATION_SUCCEEDED` (fires on every successful verify,
including a legitimate re-authentication), `GUEST_VERIFICATION_FAILED_LIMIT` (only on the attempt
that triggers a lockout — not one event per wrong attempt, avoiding audit-log noise while still
recording the security-relevant event), `GUEST_SESSION_REVOKED` (on logout). None ever carry the
code, salt, or hash. Timeline: `GUEST_VERIFIED`, fired exactly once (see "Re-authentication after
session expiry" above for why it's conditional).

## Database migration

`0016_harsh_wrecker.sql`: creates `guest_otp_challenges` and `guest_sessions`, their check
constraint and FKs, and the partial unique index on `guest_otp_challenges (invitation_id) WHERE
status = 'active'`. Both FK identifier names verified under Postgres's 63-byte limit before applying
(58 and 52 bytes respectively) — no truncation risk this time, unlike Module 08/14's close calls.

## Tests

Backend: 518 total (up from 490 at the start of this module) — 6 new in `otp.test.ts` (format,
uniqueness, no-static-demo-value, deterministic/salted hashing, one-way, correct/wrong
verification) and 22 new in `guestVerification.integration.test.ts` (masked-destination-only
response, no-plaintext-persistence, resend-cooldown rejection, revoked/expired/CLOSED-Incident/
unknown-token rejection at request time, mock-provider-only delivery, correct-code success +
session-cookie-set + invitation-marked-verified, wrong-code rejection, attempt-lockout (even the
correct code fails once locked), one-time-use enforcement, resend invalidates the prior code,
concurrent-verification safety, CLOSED-Incident rejection at verify time, safe `/guest/session`
projection, unauthenticated rejection, cross-mechanism cookie rejection in both directions, logout +
post-logout denial, missing-CSRF rejection, Incident-closure-revokes-existing-session, no-Users-row
creation, and audit-event presence without the code). Frontend: 92 total (up from 89, net of
replacing the 4 pre-existing landing-page tests with 7 that also cover the OTP flow) — request → 
masked confirmation, full verify → authenticated view with no code ever in the DOM, inline
wrong-code error staying on the retry form, and session-restore-on-refresh.

## Live PostgreSQL validation

`0016_harsh_wrecker.sql` confirmed applied (re-running `db:migrate` was a clean no-op); both new
tables' FK names confirmed under the 63-byte limit before the migration was ever applied.

## Live mock/E2E validation

Curl-driven against the running dev backend: an OTP request for a nonexistent token correctly
returns `404 {"error":"invitation_not_found",...}`; `GET /guest/session` with no cookie correctly
returns `401`. The full request → capture-code-via-test-seam → verify → session-cookie-set →
`/guest/session` → logout → post-logout-denial → Incident-closure-denies-existing-session workflow
is additionally exercised end-to-end by the 22-test live-database integration suite (real Fastify
app, real PostgreSQL, `inject()`-driven HTTP-level requests).

## Known limitations / follow-up

- The "authenticated Guest experience" after verification is a minimal placeholder confirmation
  screen — the real Guest portal (Chat, War Room, incident-scoped navigation) is Module 19's scope.
- No SMS/email delivery-failure retry for the OTP notification itself (mirrors Module 17's
  `sendGuestInvitationNotification` — best-effort, not re-attempted); a Guest whose first OTP
  delivery silently fails can always resend after the cooldown.
- The old, now-unused `guest_invitations.otp_hash` column (Module 01) was left in place rather than
  dropped — removing an already-migrated column is a separate, deliberate schema-cleanup decision
  outside this module's actual scope.

## Module 19 boundary

Module 19 (Participant Management) is responsible for: activating a verified Guest into
`incident_participants`, gating actual Chat/War Room access on `authenticateGuest()`'s
`capabilities`, building the real Guest portal UI beyond the placeholder confirmation screen, and
participant-roster removal revoking Guest access. It should call `authenticateGuest()` directly
rather than re-implementing Guest session validation, and must not weaken any of the
revocation/CLOSED-Incident checks this module already enforces.
