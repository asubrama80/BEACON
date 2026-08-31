# Module 24 — Testing

## Scope

A systematic testing hardening pass across Modules 00-23 — establishing confidence in normal
workflows, authorization boundaries, concurrency, WebSocket behavior, failure scenarios, and
moderate load, not merely "add more unit tests." See
[docs/testing/TEST_STRATEGY.md](../../docs/testing/TEST_STRATEGY.md) for the durable strategy and
[docs/testing/MODULE_24_TEST_REPORT.md](../../docs/testing/MODULE_24_TEST_REPORT.md) for the full
findings/results. This file covers the implementation decisions.

## Gap analysis first, then targeted tests

Before writing anything, a full inventory pass (an Explore agent, then direct file reading) mapped
exactly what already had genuine concurrent-request coverage versus what only had sequential
`await a(); await b();` calls dressed up with a "concurrent" test name. This precision mattered —
several pre-existing tests were misleadingly named (e.g. "rejects a repeated (concurrent-style)
transition" that was actually sequential), and writing new tests without first confirming this would
have either duplicated real coverage or missed real gaps. The gap analysis found: OTP concurrent
verify and Alert dispatch concurrency were already genuinely covered; duplicate invitation creation,
duplicate webhook callbacks, and Incident lifecycle races were named as if tested but weren't;
Guest-removal-vs-Chat was fixed in Module 23; Guest-removal-vs-War-Room had no coverage at all.

## WebSocket message ordering bug (real defect found and fixed)

Writing a new test for "multiple rapid sends without waiting for each ack are persisted/broadcast
in order" (closing a stated Module 24 gap, not a hunch) failed deterministically on first run.
`chatWebsocket.ts`'s `runConnection()` ran each incoming frame's handler as an independent
`void (async () => {...})()` with zero serialization — two frames on the same connection could have
their `canSend()`/`send()` DB calls interleave and complete out of order, since nothing forced the
second frame's handling to wait for the first's.

Fixed with a per-connection FIFO promise chain: `processingChain = processingChain.then(() =>
handleFrame(raw)).catch(() => {})`. Each `.catch()` is attached per-link (not just once at the end)
specifically so an unexpected error handling one frame can never silently halt every later frame on
that connection — a rejected chain would otherwise skip every subsequent `.then()`. Verified
deterministic across 3 repeated runs of the new regression test, and confirmed to hold under real
15-client concurrent load via `scripts/load/chat-load.ts`.

## Load harness cleanup bug (process defect, not application)

The four `scripts/load/*.ts` scripts originally cleaned up their synthetic data unconditionally at
the end of `main()`. Two of them crashed mid-run while discovering real system limits (see below),
leaving orphaned Admin users behind in the shared dev database — which then caused
`users/routes.integration.test.ts`'s and `security/security.integration.test.ts`'s last-admin/
break-glass tests to fail spuriously (extra "active admin" rows threw off their own count-based
assertions). Diagnosed by directly querying the dev database for `test-c24-%`-prefixed users,
manually removing the orphaned rows (users, roles, incidents, contacts, alerts — in dependency
order), then re-running the full suite 3x to confirm a clean baseline. All four scripts were then
rewritten with `try { ... } finally { cleanup(); }` so this can't recur. This was **never** a defect
in the shipped application — the load scripts are standalone dev tooling that never ships and were
never part of the CI-facing `npm test` surface — but it's a real lesson worth keeping: standalone
scripts that write to a shared dev database need the exact same cleanup discipline as test files.

## Two real system limits surfaced (not bugs)

The Alert-recipient-scale harness hit `400 body/contactIds must NOT have more than 500 items`
(Module 09's existing server-side max-recipient schema limit) and the Import-scale harness hit
`400 import_file_invalid: too many rows (max 2000)` (Module 05's existing file-size safety bound) —
both deliberate, pre-existing safety measures working exactly as designed. The load harness's tiers
were adjusted to respect them (100/500 and 1000/2000 respectively) rather than working around them.

## Chat WebSocket connection-ordering convention (documented, not new)

While debugging the initial hang in `chat-load.ts` (client code sent frames immediately on the
client-side "open" event, racing the server's async connection setup before it had attached its own
message listener — silently dropping the first frames), the fix was to match the exact convention
`chatWebsocket.test.ts`'s own `connect()` helper already uses: attach the message listener from
socket creation, and always wait for the server's "connected" acknowledgement frame before sending
anything. This wasn't a new pattern — it was rediscovering, the hard way, a convention the test
suite had already established, which is why it's now called out explicitly in
[TEST_STRATEGY.md](../../docs/testing/TEST_STRATEGY.md)'s "WebSocket approach" section for future
scripts/tests to find without repeating the debugging.

## Database constraint testing

`backend/src/test/dbConstraints/dbConstraints.integration.test.ts` deliberately bypasses every
service-layer pre-check via direct `db.insert()` calls, proving 17 distinct schema-level
invariants (unique indexes and check constraints across `users`, `user_roles`, `group_members`,
`guest_invitations`, `guest_otp_challenges`, `incident_participants`, `incident_war_rooms`,
`war_room_sessions`, `alert_recipients`, `notification_delivery_events`) are the real safety net,
not just a service-layer convenience. One implementation detail worth recording: Drizzle wraps the
underlying `postgres` driver error in a `DrizzleQueryError`, whose `.cause` carries the actual
`PostgresError` (with the standard `code`, e.g. `23505` for a unique violation, `23514` for a check
violation) — asserting directly on the outer error's own `code` property fails, since it doesn't
have one; tests must match against `{ cause: { code } }`.

## Transaction rollback testing — deliberately no mocking framework

Section 13's ask ("intentionally inject failures if existing service seams permit") ran into a real
constraint: nearly every multi-step business flow already reviewed in Module 23
(`disableUser`/`removeRole`, OTP verify+enrollment, Incident transitions, Guest removal) is already
guarded against natural constraint collisions by its own pre-checks — a *good* design property that
makes injecting a *realistic* mid-transaction failure into one of them contrived rather than
natural. Building `vi.mock`/`vi.spyOn` machinery to force one would have been exactly the "elaborate
fault-injection framework" this module's own spec says not to build, and this codebase has zero
existing precedent for that kind of mocking (a deliberate convention — see
[TEST_STRATEGY.md](../../docs/testing/TEST_STRATEGY.md)'s "Tooling" section). Instead,
`backend/src/test/transactionRollback/` directly and honestly proves the shared `db.transaction()`
primitive every one of those flows depends on: a real write, followed by a real thrown error, proven
rolled back — for both a single-table and a cross-table case, plus a control case. Combined with the
already-completed Module 23 code review confirming every critical flow correctly uses this
primitive, this is sufficient, honest evidence without contrived fault injection.

## Critical end-to-end workflow tests — the largest structural gap

`backend/src/test/e2e/criticalWorkflows.integration.test.ts` is the first test file in this codebase
that chains a journey across modules (login → Incident lifecycle → Alert dispatch → Guest invite/
OTP/Chat/War Room → removal → Incident close → Audit → Administration) rather than staying scoped
to one module's own routes — every other integration suite, correctly by its own module's design,
never did this. Structured as one `describe` per section (8.1-8.7) with sequential `it()`s that
build on shared outer-scope state (a deliberate "journey" pattern, matching how `beforeAll` chains
are already used elsewhere in this codebase) — Vitest runs tests within a file in declaration order,
so this is reliable, not fragile.

## Time-boundary testing — fixing a misleading pre-existing test

The gap analysis found `auth/routes.integration.test.ts`'s existing "rejects an expired session"
test only proved an *unrecognized* token is rejected — it inserted a session row with a past
`expiresAt` but then tested a *different*, never-matching cookie value, never actually exercising
the `gt(sessions.expiresAt, now)` comparison in the real lookup query. `backend/src/test/
timeBoundaries/` fixes this class of gap for all three TTL-bearing concepts (session, OTP challenge,
Guest invitation) by creating a genuinely valid row via the real flow, capturing its real token,
directly pushing its real `expiresAt` into the past, and then proving the *same* token/code is now
rejected — via the actual expiry-comparison code path, not a coincidental no-match.

## Frontend gap: Administration/Audit navigation had no hide/show test

`App.test.tsx` already had thorough permission-gated nav tests for Users/Contacts/Groups/Templates/
Incidents/Alerts (show-when-permitted, hide-when-not, for every one) but had never been extended to
Administration or Audit when those modules shipped — a genuine, if narrow, testing debt. Five new
tests close it, following the exact existing convention (same `mockAuthMe`/inline-fetch-stub
patterns already established in the file), plus one new test confirming a Guest session cookie never
grants access to the authenticated shell.

## Live validation (a11y/responsive smoke)

A temporary synthetic Admin user, browser-driven walkthrough (established pattern from Modules
19/21/22/23): login form confirmed to have real `<label>`-associated inputs and a real submit
button; the Administration page's role/permission table confirmed to use genuine semantic
`<table>/<thead>/<th>/<tbody>` markup (the accessibility-tree tool's own "generic" labeling for
header cells was a tool-rendering simplification, not a real gap — verified by inspecting the actual
DOM via `javascript_tool`). One real finding: at a 375px mobile viewport, the top navigation bar
overflows horizontally with no wrap/menu affordance, hiding most nav items from a mobile user.
Documented in the test report rather than fixed — a layout change is outside this module's testing
scope and risks the "do not redesign the prototype" boundary explicitly set for this module.

## Coverage

`@vitest/coverage-v8` added as a backend devDependency (matching the already-installed `vitest`
major version) — a minimal, official, first-party addition, not a new framework. One report
generated (`npm run test:coverage --workspace backend`), read for insight (documented in the test
report), never treated as a gate or a percentage target to chase. The one deliberately-understood
low-coverage area — the real Twilio/SES provider adapters — reflects that exercising their actual
SDK call paths would need live credentials, explicitly out of this module's scope; their
signature-verification and webhook-handling logic (which doesn't need live credentials) is already
thoroughly tested separately.

## Module boundaries

Modules 15/16 (Audio/Video, Screen Sharing) remain deferred — untouched. Module 27 (Provider
Configuration) remains unstarted. Modules 25 (Docker Deployment) and 26 (Production Readiness)
remain unstarted — no CI workflow file, no container/deployment tooling, no infrastructure hardening
was introduced; every test command is CI-shaped but nothing runs them automatically yet, which is
explicitly left for Module 25.
