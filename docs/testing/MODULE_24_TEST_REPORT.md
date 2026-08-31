# Module 24 — Testing: Final Report

See [TEST_STRATEGY.md](TEST_STRATEGY.md) for the durable strategy document and
[claude/prompts/24-testing.md](../../claude/prompts/24-testing.md) for the implementation log.

## Baseline (verified before any work began)

Matched the reported baseline exactly: HEAD `608365f` == `origin/master`; backend 607 / frontend
120 / database 12 tests passing; lint/typecheck/build clean across all three workspaces; 19
migrations applied (through `0018`); 48 permissions seeded, idempotent; `docs/security/
SECURITY_REVIEW.md` present; prototype unchanged; Modules 15/16 deferred, 22/23 complete, 24-27 not
started. No discrepancy found — proceeded without stopping.

## Tests added this module

| Area | File | New tests |
|---|---|---|
| Concurrency (invitation, webhook, lifecycle races) | `backend/src/test/concurrency/concurrency.integration.test.ts` (new) | 5 |
| Concurrent participant enrollment | `backend/src/test/participants/guestParticipant.integration.test.ts` (extended) | 1 |
| Guest removal vs. War Room race | same file | 1 |
| WebSocket hardening (malformed cookie, rapid-frame ordering) | `backend/src/test/chat/chatWebsocket.test.ts` (extended) | 2 |
| Database constraints (direct insertion attempts) | `backend/src/test/dbConstraints/dbConstraints.integration.test.ts` (new) | 17 |
| Time-boundary / TTL expiry | `backend/src/test/timeBoundaries/timeBoundaries.integration.test.ts` (new) | 3 |
| Malformed Twilio webhook payload | `backend/src/test/notifications/twilioWebhook.test.ts` (extended) | 2 |
| Transaction rollback / atomicity | `backend/src/test/transactionRollback/transactionRollback.integration.test.ts` (new) | 3 |
| Critical end-to-end workflows | `backend/src/test/e2e/criticalWorkflows.integration.test.ts` (new) | 31 |
| Admin/Audit nav visibility, Guest-cookie shell denial | `frontend/src/App.test.tsx` (extended) | 5 |

Backend: 607 → **672** (+65). Frontend: 120 → **125** (+5). Database: unchanged at **12** (no
schema/migration change this module). **Total: 809.**

## Critical workflows covered

All of section 8's required workflows are covered by the new `criticalWorkflows.integration.test.ts`
(31 tests, one continuous journey per describe block):

- **8.1 Registered responder auth** — login → Dashboard, permissions loaded, no secret leakage in
  `/auth/me`; a separate MFA-enrolled User proven to require and accept a real TOTP code.
- **8.2 Incident lifecycle** — create → activate → add participant → (rejected re-activate) →
  resolve → reopen → resolve, with timeline verified to contain every transition in order.
- **8.3 Alert workflow** — create (with a real Contact recipient) → preview → ready (immutable
  snapshot) → dispatch (mock provider) → simulated delivery, with `submitted` and `delivered`
  proven distinct at each step, and Dashboard reflecting the result.
- **8.4 Guest workflow** — invite → OTP request (test-capture, never real SMS/email) → verify →
  auto-enrollment (never a `users` row) → Chat access → War Room open/join/read → removal →
  immediate denial of the Guest's own session.
- **8.5 Incident close + Guest** — a still-active Guest, then Incident close, then immediate denial
  verified across three surfaces: session check, Chat history, War Room join.
- **8.6 Audit workflow** — representative events (Incident creation, Guest OTP verification)
  verified for correct actor attribution and searchability.
- **8.7 Administration workflow** — Admin creates a User, performs a security action (session
  revoke) with exactly-one audit event, Guest/low-privilege denial confirmed, and the last-admin
  safeguard re-verified within this same journey.

**Notable finding:** no such cross-module journey test existed anywhere in the codebase before this
module — every prior integration suite (correctly, by its own module's design) stayed scoped to its
own routes. This was the single largest structural gap Module 24 closed.

## Concurrency

| Scenario | Result | Bug found/fix |
|---|---|---|
| Last-admin race (two concurrent disables) | Closed — exactly one `200`, one `409`, never zero admins | Fixed in **Module 23** (`db.transaction()` + `SELECT ... FOR UPDATE`); re-verified here |
| OTP concurrent verify (same code) | Already safe — at least one `200`, exactly one `GUEST_VERIFIED` event | None needed |
| Concurrent participant enrollment (row count) | Closed — exactly one `incident_participants` row under genuine `Promise.all` verify race | None needed — `markInvitationVerified`'s conditional `UPDATE` already race-safe |
| Duplicate Guest invitation creation (concurrent) | Closed — exactly one `201`, one `409` | None needed — the existing partial unique index already serializes it |
| Concurrent Alert dispatch | Already covered pre-Module-24 (`dispatch.integration.test.ts`, `dispatchEngine.test.ts`) | None needed |
| Concurrent duplicate delivery webhook (Twilio + SES) | Closed — exactly one `processed`, one `duplicate`, one DB row | None needed — `dedupe_key` unique index already serializes it |
| Concurrent Incident lifecycle transitions (two closes; close vs. reopen) | Closed — exactly one winner, final state always valid | None needed — the existing conditional `WHERE status = ...` UPDATE already serializes it |
| Guest removal vs. Chat (persistent WebSocket) | Closed | Fixed in **Module 23** (per-send participant-status re-check); re-verified here |
| Guest removal vs. War Room (discrete requests) | Closed — either ordering is safe by construction (no persistent connection to outlive removal); confirmed new access is denied post-removal | None needed |

## WebSocket

- **Auth**: unauthenticated (no cookie) and syntactically-invalid-cookie (new) both correctly
  rejected `401`.
- **Cross-Incident**: a Guest's socket cannot open against an Incident other than the one their
  invitation belongs to (pre-existing coverage, confirmed still passing).
- **Revocation**: the mandatory Module 23 finding — a removed Guest's already-open socket is now
  rejected per-send, not just at connection time — re-verified as part of this module's regression
  pass.
- **Sequencing**: a real bug found and fixed — see "Bugs found" below.
- **Load**: 15 simultaneous clients × 5 messages each (75 total sends) via `scripts/load/
  chat-load.ts` — 0 errors, all 75 persisted and acknowledged, ~415-655ms elapsed across runs.

## Database

**Constraints tested via direct insertion (bypassing service logic):** `users.email` uniqueness,
single break-glass account, `user_roles` assignment uniqueness, `group_members` membership
uniqueness, Guest invitation active-destination uniqueness, the invitation contact-method check
constraint, one-active-OTP-challenge-per-invitation, `incident_participants`' three
exactly-one-identity partial unique indexes plus its reference check constraint (both the
"mismatched type" and "no identity set" cases), the War Room single-open-room and
single-active-session constraints plus its reference check, `alert_recipients`' per-Alert Contact
uniqueness, and `notification_delivery_events.dedupe_key` uniqueness (the real webhook-idempotency
guarantee). All 17 confirmed enforced at the schema layer via real Postgres `23505`/`23514` errors
caught through Drizzle's `DrizzleQueryError.cause`.

**Transaction rollback findings:** the shared `db.transaction()` primitive (relied on by every
multi-step business flow already reviewed in Module 23 — `disableUser`, `removeRole`, OTP
verify+enrollment, Incident transitions, Guest removal) genuinely rolls back every write made
before a later throw, verified for both a single-table and a cross-table (3-table) case, plus a
control case proving a successful transaction commits normally.

## Failure paths

- **Provider failure/retry**: already thoroughly covered pre-Module-24 by `dispatchEngine.test.ts`'s
  injectable mock-provider outcome resolver (transient retry, permanent no-retry, bounded exhaustion,
  partial success). No new coverage needed.
- **Malformed webhook**: Twilio's route now also tested against a validly-signed but
  field-incomplete payload (missing `MessageStatus`, missing `MessageSid`) — both correctly
  `400 invalid_payload`, never mistaken for a signature failure. SES's equivalent was already
  covered pre-Module-24.
- **DB/service failure**: not simulated against the live dev database (would require destabilizing
  a shared resource); instead verified by direct code reading that `checkDatabaseHealth()` never
  throws and the global error handler sanitizes any unexpected error — documented, not
  re-implemented as a mock-based test, consistent with this codebase's no-mocking-framework
  convention.
- **Malformed requests generally**: already extensively covered by every module's own schema
  validation tests (unchanged, re-verified passing in the 3x regression run).

## Load baseline (local developer workstation — not a production capacity guarantee)

**API** (`scripts/load/api-load.ts`, real listening server, real `fetch()`):

| Scenario | Concurrency | Requests | Errors | p50 | p95 | p99 |
|---|---|---|---|---|---|---|
| `GET /health` | 10 / 25 / 50 | 50 / 125 / 250 | 0 | 16-42ms | 43-164ms | 47-168ms |
| `GET /dashboard` (auth) | 10 / 25 / 50 | 50 / 125 / 250 | 0 | 209-802ms | 319-1196ms | 334-1214ms |
| `GET /incidents` (list) | 10 / 25 / 50 | 50 / 125 / 250 | 0 | 43-201ms | 55-232ms | 58-247ms |
| `GET /audit` (list) | 10 / 25 / 50 | 50 / 125 / 250 | 0 | 45-244ms | 81-274ms | 81-281ms |

**Observation**: `/dashboard`'s latency grows the most under concurrency (up to ~1.2s p99 at
concurrency 50) — expected, since it fans out to five Promise.all'd sub-queries per request against
the shared connection pool (`max: 10`); at concurrency > pool size, requests queue for a connection.
Not flagged as a defect — a pool-sizing characteristic to keep in mind for Module 26, not something
Module 24 should "fix" by resizing infrastructure.

**Chat** (`scripts/load/chat-load.ts`): 15 simultaneous WebSocket clients × 5 messages each — 75
sent, 75 acknowledged, 0 errors, 0 dropped/corrupted messages, ~415-655ms elapsed. Confirms the
Module 24 ordering fix holds under real concurrent multi-client load, not just the single-client
regression test.

**Alert recipient scale** (`scripts/load/alert-recipient-scale.ts`): 100 and 500 Contacts (500 is
the real system-enforced ceiling — see "Bugs found," item 3) — both tiers resolved with
`eligibleCount`/persisted-recipient-row counts exactly matching input size, 0 mismatches.
Contact-insert 25-70ms, Alert-create 102-384ms, preview 33-76ms, ready 71-336ms.

**Import scale** (`scripts/load/import-scale.ts`): 1000 and 2000 rows (2000 is the real
system-enforced ceiling — see "Bugs found," item 4) — both tiers imported exactly the expected
count, 0 skipped, 0 residual PII after cleanup. Upload 47-116ms, preview 991-1872ms, confirm
3900-7852ms. **Observation**: confirm scales roughly linearly with row count and is the slowest
step by a wide margin (likely per-row insert work) — a legitimate characteristic to note for anyone
tuning import UX later, not something this testing module should optimize.

No catastrophic memory growth, uncontrolled error rate, or DB contention beyond the expected
connection-pool queuing was observed at any tier tested.

## Bugs found

### 1. Chat WebSocket messages could be persisted/broadcast out of order under rapid sends (Medium — fixed)

**Behavior**: sending multiple frames on the same connection without waiting for each ack could
result in them being persisted (and thus broadcast) in a different order than sent — proven with a
new test asserting five rapid unwaited sends come back in order; the pre-fix implementation failed
this deterministically on the first run.

**Root cause**: `chatWebsocket.ts`'s `socket.on("message", ...)` ran each frame's handler as an
independent `void (async () => {...})()` with no serialization — concurrent `canSend()`/`send()` DB
calls for different frames on the same connection could interleave and complete out of order.

**Fix**: frames are now processed strictly FIFO via a per-connection promise chain
(`processingChain = processingChain.then(() => handleFrame(raw)).catch(() => {})`) — the next frame
never starts until the previous one's full handling (including its DB write) has settled.

**Regression test**: `chatWebsocket.test.ts`, "multiple rapid sends without waiting for each ack are
persisted and broadcast in order" — deterministic across 3 repeated runs.

### 2. Load-harness scripts left orphaned data on failure, briefly breaking unrelated tests (Process defect, not application — fixed)

**Behavior**: an early iteration of the Module 24 load scripts (before they were finished) crashed
partway through (hitting real, then-undiscovered system limits — see items 3/4 below) without
cleaning up their synthetic Admin users/Incidents/Contacts. The orphaned "extra" active ADMIN users
then caused `users/routes.integration.test.ts`'s and `security.integration.test.ts`'s last-admin/
break-glass tests to fail spuriously.

**Root cause**: cleanup code ran unconditionally at the end of `main()`, never reached if an
earlier step threw.

**Fix**: all four load scripts wrapped in `try { ... } finally { cleanup(); }`; orphaned data from
the earlier failed runs was manually identified and removed from the shared dev database; the full
regression suite was re-run 3x afterward to confirm a clean baseline. **Not a defect in the shipped
application** — the load scripts are standalone dev tooling, never part of the deployed product or
the CI-facing test suite.

### 3. Alert creation enforces an undocumented-to-this-report 500-Contact-per-request ceiling (Confirmed existing behavior, not a bug)

Discovered via the load harness hitting `400 body/contactIds must NOT have more than 500 items`.
This is Module 09's own deliberate server-side max-recipient safety limit (schema-level), working
as designed — documented here because the load harness is what surfaced the exact number.

### 4. Contact import enforces a 2000-row-per-file ceiling (Confirmed existing behavior, not a bug)

Discovered via the load harness hitting `400 import_file_invalid: too many rows (max 2000)`.
Module 05's own deliberate file-size safety bound, working as designed — same treatment as item 3.

No other defects were found. Every other concurrency/constraint/failure-path scenario tested was
already correctly handled by the existing implementation.

## Security

No new security regressions found. The Module 23 security suite (`security/
security.integration.test.ts`) re-ran clean 3x. No secrets, credentials, or PII appeared in any new
test output, load-script console output, or committed file (spot-checked; load scripts print only
counts/timings/status codes). Dependency findings are unchanged from Module 23 (2 moderate,
documented, not re-litigated here) — `@vitest/coverage-v8` was added as a devDependency and
contributes no new findings (`npm audit` re-run showed the same 6 moderate total across the
monorepo, all pre-existing).

## Quality gates

- **3 consecutive full regression runs**: backend 672/672 all three times; frontend 125/125 all
  three times; database 12/12 all three times. Zero flaky or unexplained failures.
- **Lint**: clean, all three workspaces.
- **Typecheck**: clean, all three workspaces.
- **Build**: clean, all three workspaces.
- **Migration**: unchanged, 19 files applied (through `0018`) — no new migration this module.
- **Seed**: 48 permissions, re-run confirmed idempotent.
- **`git diff --check`**: clean.
- **Prototype**: unchanged.
- **Secret scan**: clean.
- **PII review**: clean — all test data synthetic, `@example.invalid` emails throughout.

## Known limitations / residual risk

- No dedicated CI workflow file exists yet (Module 25's concern) — every command is already
  CI-shaped, but nothing runs them automatically on push.
- Load testing establishes a local baseline only; not a capacity-planning or SLA tool.
- No browser-automation E2E suite was introduced — frontend testing remains component-level plus
  one live manual/browser smoke pass, per this module's own instruction against installing a large
  E2E platform without strong justification.
- A real responsive-layout gap was observed during the live smoke pass: at a 375px mobile viewport,
  the top navigation bar overflows horizontally with no wrapping or menu affordance, hiding
  Contacts/Groups/Templates/Users/Audit/Administration/Log-out from a mobile user without
  horizontal scrolling. Documented here rather than fixed — a UI/layout change is outside this
  testing module's scope and risks the "do not redesign the prototype" boundary; a future module
  should address it deliberately.
- Provider adapter code (`sesProvider.ts`, `twilioProvider.ts`) shows low statement coverage
  (23%/7%) in the coverage report generated this module — expected and understood: exercising the
  real Twilio/SES SDK call paths would require live credentials or extensive SDK mocking, both
  explicitly out of this module's scope (their signature-verification and webhook-handling
  surfaces, which don't require live credentials, are thoroughly tested separately).
- The two moderate dependency findings from Module 23 (`exceljs`→`uuid`, `drizzle-kit`→`esbuild`)
  remain unpatched with the same documented rationale; not re-evaluated as "clearly exploitable" by
  anything found this module.

## Module status

- 15 Audio/Video — deferred (unchanged)
- 16 Screen Sharing — deferred (unchanged)
- 22 Administration — complete (unchanged)
- 23 Security Hardening — complete (unchanged)
- **24 Testing — complete**
- 25 Docker Deployment — not started
- 26 Production Readiness — not started
- 27 Provider Configuration — not started

## Recommendation before Module 25

- The mobile-navigation overflow finding (above) is worth a deliberate, scoped fix before this
  application is used on any handheld device — likely a Module 25/26-adjacent UI task, not a
  blocker for deployment tooling itself.
- Consider whether Module 25's CI workflow should run the security/concurrency/dbConstraints/e2e
  suites as their own labeled jobs (they're already organized that way) versus one flat `npm test`.
- The `/dashboard` latency-under-concurrency characteristic (this report's Load baseline section) is
  worth keeping in mind if Module 26 does real capacity planning — not an action item now.
