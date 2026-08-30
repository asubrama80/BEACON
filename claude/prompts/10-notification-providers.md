# Module 10 — Notification Providers

## Scope

A provider-agnostic notification dispatch layer that takes Module 09's immutable READY Alert
Recipient snapshots and submits them to an external SMS/Email provider. This module owns
*submission* only — provider abstraction/configuration, dispatch idempotency, credential
handling, submission-result capture, and bounded retry/error classification. It does **not**
resolve Groups, query Contacts/Templates, render placeholders, change recipient snapshots,
determine final human delivery status, or process provider callbacks/webhooks — all confirmed
empty via grep across `backend/src/modules/notifications/` and `dispatchAlert()`.

## Provider boundary

`dispatchAlert()` (`backend/src/modules/alerts/service.ts`) never imports or calls
`findContactById`/`findContactsByIds`, `getGroupMemberContactIds`/`findGroupById`, or
`findTemplateById`/`renderTemplate` — grep-confirmed empty inside its body. It reads only
`alert_recipients` rows already written by Module 09's READY transaction
(`getPendingRecipients`), and sends exactly `{destination, renderedSubject, renderedBody}` from
that frozen row to the provider. Live-verified: changing a Contact's phone, a Contact's name, a
Template's body, and a Group's membership *after* READY — in every case, dispatch still submitted
the original frozen snapshot unchanged.

## READY snapshot contract

`alert_recipients.recipient_address` / `.rendered_subject` / `.rendered_body`, written once by
Module 09 at READY time, are the *only* data Module 10 ever sends to a provider. This module adds
no new columns to that snapshot contract — only submission-tracking columns (`provider`,
`attempt_count`, `last_failure_class`, `last_error_code`, `last_error_summary`,
`provider_message_id` (pre-existing), `submitted_at`/`failed_at` (pre-existing)).

## Provider interfaces

`backend/src/modules/notifications/providers/types.ts`: channel-neutral `SmsProvider`/
`EmailProvider` interfaces (`send(request): Promise<ProviderSubmissionResult>`), and
provider-neutral request/result shapes (`SmsSendRequest`/`EmailSendRequest`,
`ProviderSubmissionResult { accepted, provider, providerMessageId?, failureClass?, errorCode?,
safeErrorMessage? }`). Adapters never see a DB row or a raw Contact/Template — only these shapes.

## Provider registry

`backend/src/modules/notifications/providers/registry.ts` — `getSmsProvider()`/
`getEmailProvider()` are the *only* place a Twilio/SES client is ever constructed; business logic
(`dispatchAlert`) never instantiates a provider directly. Resolved from `SMS_PROVIDER`/
`EMAIL_PROVIDER` env config. Called eagerly at `buildApp()` startup (`backend/src/app.ts`) so a
misconfigured provider selection (e.g. `SMS_PROVIDER=twilio` with no credentials) fails the app
at boot, not silently at an operator's first real dispatch attempt. Never falls back to mock on a
config error — throws instead.

## Mock provider

`backend/src/modules/notifications/providers/mockProvider.ts` — the default for both channels.
Makes zero network calls; returns a deterministic synthetic `providerMessageId` (`mock-{provider}-
{alertRecipientId}`); never logs body/destination. Its only configurable behavior (a
`MockOutcomeResolver` for simulating transient/permanent failures) is a constructor parameter,
never reachable through any request or environment-variable path — production/dev routes always
get the always-accept default; only test code that imports the factory directly can inject a
custom resolver (used by `backend/src/test/notifications/dispatchEngine.test.ts`).

## Twilio adapter

`backend/src/modules/notifications/providers/twilioProvider.ts` — calls Twilio's REST Messaging
API directly via `fetch()` with HTTP Basic Auth, rather than pulling in the full `twilio` SDK
(kept the dependency footprint minimal for one documented HTTP call). Bounded via
`AbortController`/`PROVIDER_TIMEOUT_MS`. Classifies `429`/`5xx` and a known-permanent Twilio
error-code set (invalid/unreachable destination, etc.) into `transient`/`permanent`; never logs
the destination or body.

## SES adapter

`backend/src/modules/notifications/providers/sesProvider.ts` — uses the official
`@aws-sdk/client-ses` (SigV4 signing is genuinely error-prone to hand-roll safely, unlike
Twilio's simple Basic-Auth call). Standard AWS credential-chain resolution — no long-lived AWS
secret is ever stored in the application database or `.env`; only `AWS_REGION`/`SES_FROM_EMAIL`
are BEACON-specific config. Plain-text email body, consistent with Module 07. Bounded via
`NodeHttpHandler`'s `requestTimeout`/`connectionTimeout`. Classifies AWS SDK error names
(`Throttling`, `ServiceUnavailable`, 5xx/429) as `transient`; everything else (e.g.
`MessageRejected`) as `permanent`.

## Environment configuration

`SMS_PROVIDER`/`EMAIL_PROVIDER` (`mock` default for both), `TWILIO_ACCOUNT_SID`/
`TWILIO_AUTH_TOKEN`/`TWILIO_FROM_NUMBER`, `AWS_REGION`/`SES_FROM_EMAIL`,
`PROVIDER_MAX_ATTEMPTS` (default 3), `PROVIDER_RETRY_BASE_MS` (default 500),
`PROVIDER_DISPATCH_CONCURRENCY` (default 5), `PROVIDER_TIMEOUT_MS` (default 10000). Names only
added to `.env.example`; no real secret values anywhere in the repo.

## Credential security

Grep-confirmed: no credential values in source, no credential logging, no credential in any API
response, audit row, or timeline event. `GET /alerts/provider-status` (gated on `alerts.dispatch`)
exposes only `{sms: {provider, configured}, email: {provider, configured}}` — provider *name* and
a boolean, never a secret. Verified via a dedicated unit test that the serialized response never
contains a configured Twilio token/SID substring.

## Dispatch lifecycle

`READY` (Module 09 — approved, frozen) → **explicit** `POST /alerts/:id/dispatch` (Module 10 —
begins provider submission) → `submitted` / `partially_submitted` / `submission_failed`. READY
never auto-dispatches; Dispatch is a deliberate, separate operator action, gated by its own
`alerts.dispatch` permission (distinct from `alerts.ready`).

## Alert vs recipient submission state

**Alert-level** (`alerts.status`, aggregate, derived from recipient states after each dispatch
call): `dispatching` (transiently held during the synchronous dispatch call, or if any recipient
still isn't terminal), `submitted` (all recipients submitted), `partially_submitted` (mixed
submitted/failed), `submission_failed` (all failed). The pre-existing `queued`/`sending`/`sent`/
`failed` placeholders remain structurally allowed but unused — superseded by these more precise
values, which never claim delivery.

**Recipient-level** (`alert_recipients.status`): `pending_delivery` (Module 09's initial state) →
`dispatching` (claimed, in flight) → `submitted` (provider accepted) or `submission_failed`
(permanent failure or retries exhausted). `queued`/`delivered`/`failed` remain unused, reserved
for Module 11.

## Provider result model

`ProviderSubmissionResult` — `accepted: true` means only "the provider accepted the message,"
never "a human received it." On failure: `failureClass` (`transient`/`permanent`), `errorCode`,
and a `safeErrorMessage` — never a raw provider response body.

## Transient/permanent error model

Structured classification per adapter (HTTP status + known error-code sets), not fragile
message-text matching. `429`/`5xx` and known transient provider error names → `transient`
(retryable); a known-permanent error code, or any other `4xx`, → `permanent` (never retried).

## Retry behavior

Bounded exponential backoff with jitter (`backoffWithJitter`, capped at 30s), up to
`PROVIDER_MAX_ATTEMPTS` attempts per recipient — never infinite. A `permanent` failure short-
circuits immediately regardless of attempts remaining. Tests use `retryBaseMs: 5` for fast,
deterministic runs.

## Idempotency model

The primary guarantee is a single conditional `UPDATE alert_recipients SET status='dispatching',
attempt_count=attempt_count+1 WHERE id=? AND status='pending_delivery'`
(`claimRecipientForDispatch`) — only one caller can ever win it for a given recipient; a second
concurrent/duplicate call sees 0 affected rows and skips that recipient entirely (proven via a
genuine `Promise.all` concurrent-claim test: exactly one of two simultaneous claims wins). A
secondary, complementary guard sits at the Alert level: `dispatchAlert` itself does a conditional
`UPDATE alerts SET status='dispatching' WHERE status IN (...)`, so two concurrent
`POST /alerts/:id/dispatch` calls for the *same* Alert can't both proceed — the loser gets a clean
`409 dispatch_in_progress`. A dispatch call against an already-fully-`submitted` Alert is treated
as an idempotent no-op (200, current summary), not an error, since re-invoking Dispatch safely
after a network hiccup or double-click is an expected operational scenario.

**Honest limitation**: this is *at-least-once-prevention with best-effort idempotency*, not
provably exactly-once. A crash between "DB marks `dispatching`" and "DB saves the provider
result" leaves that recipient stuck in `dispatching` with no automatic recovery — deliberately
**not** auto-reclaimed, since blindly reclaiming risks a genuine duplicate send if the provider
had actually already accepted the message before the crash. This is documented as a known
limitation, not silently glossed over — see below.

## Dispatch attempt history

`notification_dispatch_attempts` — one append-only row per provider-submission attempt
(`alert_id`, `alert_recipient_id`, `channel`, `provider`, `attempt_number`, `status`,
`provider_message_id`, `failure_class`, `provider_error_code`, `safe_error_summary`,
`started_at`/`completed_at`). Inserted (status `dispatching`) *before* the provider call and
updated with the outcome after — reduces, never eliminates, the crash-window ambiguity above.
Never holds destination, subject, body, or credentials — grep/test-verified. No update/delete
endpoint exists; a retry always creates a *new* attempt row rather than rewriting history.

## Concurrency limits

`dispatchRecipients` processes recipients in chunks of `PROVIDER_DISPATCH_CONCURRENCY` (default
5) via `Promise.all` per chunk — never unbounded parallel outbound calls. No single giant
transaction ever wraps dispatch or the remote provider I/O (grep-confirmed: `dispatchAlert` and
the notifications module never call `db.transaction()`) — only small, atomic per-recipient state
transitions around each provider call.

## Timeout handling

Every provider call is bounded by `PROVIDER_TIMEOUT_MS` (default 10s): Twilio via
`AbortController`, SES via `NodeHttpHandler`'s request/connection timeout, and (belt-and-suspenders,
covers the mock provider too) an outer `Promise.race` in the dispatch engine that resolves a
`transient` timeout result if a call exceeds the budget.

## Cancellation change from Module 09

Module 09 allowed `READY → CANCELLED` unconditionally, since no dispatch mechanism existed yet.
Module 10 revises this: cancellation is rejected (`409 dispatch_already_started`) once **any**
recipient has moved past `pending_delivery` — i.e. dispatch has genuinely claimed at least one
recipient — regardless of the Alert's current status (`ready`, `dispatching`, `submitted`,
`partially_submitted`, or `submission_failed` are all treated as "dispatch has started").
`DRAFT → CANCELLED` and `READY → CANCELLED`-before-any-claim remain unchanged. Live/integration-
verified.

## Incident CLOSED behavior

Checked once, before the Alert-level dispatch claim: a closed linked Incident rejects the
dispatch attempt outright (`409 incident_not_eligible`), consistent with Module 09's `ready`
check. Once dispatch has validly claimed the Alert, a later Incident closure does **not** interrupt
already-in-flight recipient processing for that same synchronous call — a deliberate, documented
tradeoff (this module holds no long-running lock to interrupt against, and half-cancelling
in-flight provider calls would be its own source of ambiguity).

## Permissions

New code: `alerts.dispatch`.

| Role | Grants |
|---|---|
| ADMIN | yes |
| COMMUNICATION_MANAGER | yes |
| INCIDENT_COMMANDER | yes |
| AUDITOR | no |
| RESPONDER | no |

Deliberately separate from `alerts.ready` — approving a plan and beginning external submission are
different operational decisions.

## APIs

`POST /alerts/:id/dispatch` (gated `alerts.dispatch`, CSRF-required) — returns
`{alertId, status, totalRecipients, submitted, submissionFailed, pending}`. Recipient-level
submission detail (`provider`, `providerMessageId`, `attemptCount`, `lastFailureClass`,
`lastErrorCode`, `lastErrorSummary`, `submittedAt`, `failedAt`) was added to the existing
`GET /alerts/:id/recipients` (still gated `alerts.recipients.read`) rather than a new endpoint.
`GET /alerts/provider-status` (gated `alerts.dispatch`) exposes safe provider metadata for the
frontend's mock-mode labeling. `GET /alerts/:id` gained persisted `submittedCount`/
`submissionFailedCount`/`pendingDispatchCount` so the UI shows an accurate summary even after the
modal is closed and reopened.

## Frontend

`AlertDetailModal.tsx`: for a READY Alert with `alerts.dispatch`, a "Dispatch Alert" button opens
an explicit confirmation showing channel, recipient count, Alert title, Incident (or Standalone),
and an honest provider-mode line ("Provider: Mock / Development — no external SMS will be sent."
or the real provider name with a warning that a real message will be sent) fetched from
`GET /alerts/provider-status`. After dispatch, a "Submission" section shows submitted/failed/
pending counts with explicit wording that "Submitted" means provider acceptance, not delivery —
the UI never displays "Delivered." Once dispatch has begun, the Dispatch control disappears
(status is no longer `ready`).

## Audit/privacy review

Grep-confirmed empty across `backend/src/modules/notifications/`: no `console.log`, no role-name
checks, no credential logging, no webhook/callback code, no guest/OTP references. `CSRF` coverage
verified 1:1 against mutating routes. `ALERT_DISPATCH_STARTED`/`ALERT_DISPATCH_COMPLETED` audit
events carry only ids/channel/provider/counts — live-verified free of destination, body, and
credential substrings via a serialized-row scan.

## Incident timeline integration

Same two events appended to the Incident timeline (when linked), with the same safe metadata —
live-verified full sequence: `INCIDENT_CREATED → INCIDENT_ACTIVATED → ALERT_CREATED → ALERT_READY
→ ALERT_DISPATCH_STARTED → ALERT_DISPATCH_COMPLETED`, and a full-JSON PII scan confirming no
Contact name/phone/email anywhere in the timeline response.

## Database migration

`0010_woozy_banshee.sql`: new `notification_dispatch_attempts` table (+3 indexes, channel/status/
failure-class check constraints); `alert_recipients` gains `provider`, `attempt_count`,
`last_failure_class`, `last_error_code`, `last_error_summary`; both `alerts.status` and
`alert_recipients.status` check constraints extended (additively — never replacing Module 09's or
Module 01's existing allowed values).

## Tests

Backend: 355 total (up from 323 at the start of this module). New: 9 direct dispatch-engine tests
(`backend/src/test/notifications/dispatchEngine.test.ts` — success, transient-then-success retry,
permanent-no-retry, retry-exhaustion, partial success across 3 recipients, sequential and genuine
concurrent claim-idempotency, attempt-history PII-freedom); 7 provider-registry/config unit tests
(`registry.test.ts` — mock default, Twilio/SES resolution, fail-safe on missing credentials,
unrecognized-provider fallback, secret-free status); 16 HTTP-level dispatch integration tests
(`backend/src/test/alerts/dispatch.integration.test.ts` — RBAC matrix, DRAFT/CANCELLED/CLOSED-
Incident rejection, snapshot-only dispatch against post-READY Contact/Template edits, sequential
and simultaneous double-dispatch idempotency, the revised cancellation rule, audit/timeline PII-
freedom, recipient-detail PII gating). Frontend: 47 total (up from 44); 3 new dispatch-UI tests.

## Live PostgreSQL validation

Directly against `beacon_dev`: confirmed the new `alert_recipients` columns, the
`notification_dispatch_attempts` table and its indexes, the extended `alerts_status_check`
constraint definition, and 35 permissions / 89 role-permission mappings, idempotent across
repeated seeds.

## Live mock SMS workflow

Full curl-driven workflow: ADMIN login → confirmed `provider-status` returns `mock`/`mock` →
created a DRAFT SMS Alert with two Contacts → READY → Dispatch → verified `{status: "submitted",
submitted: 2, submissionFailed: 0, pending: 0}` → verified both recipient rows carry a
deterministic synthetic `providerMessageId`, `provider: "mock"`, correct frozen `destination`/
`renderedBody` → re-invoked Dispatch → verified an identical idempotent summary and **exactly 2**
attempt rows total (not 4) at the database level → attempted cancellation → verified `409
dispatch_already_started`.

## Live mock Email workflow

Created and dispatched a standalone ad-hoc Email Alert end-to-end via curl — `submitted: 1`,
confirmed via the same pattern as SMS.

## Failure/retry validation

Covered via the direct dispatch-engine test suite (live PostgreSQL, mock provider with an
injected outcome resolver — see "Mock provider" above): transient-then-success retry (2 attempts,
final state `submitted`), permanent failure (1 attempt, no retry, `submission_failed`), retry
exhaustion under a 2-attempt cap (both attempts recorded as `submission_failed`), and a 3-recipient
partial-success scenario (1 immediate success, 1 permanent failure, 1 transient-then-success) —
all persisted independently, no successful submission ever rolled back by a sibling's failure.

## Live browser validation

Full workflow through the real React frontend against the real backend with the mock provider:
login → Alerts list (five prior curl-created alerts correctly showing `SUBMITTED`) → Create Alert
→ Audience tab (search/add a Contact, real `PATCH`) → Overview → Mark Ready → Dispatch Alert →
confirmation panel showing the exact required content including "Provider: Mock / Development —
no external SMS will be sent." → Confirm Dispatch (real `POST .../dispatch`) → `SUBMITTED` badge
and "1 submitted... does not confirm the recipient received it" summary, with the Dispatch control
now gone. All requests showed proper CORS preflights and 200s; no CSRF errors.

## Real provider transmission status

**Intentionally not performed.** No real Twilio or AWS SES credentials exist in this environment,
and none were requested — per the module spec, live validation used the mock provider
exclusively, and Twilio/SES adapter correctness was verified via config-validation unit tests
(credential presence/absence, provider resolution) rather than an actual outbound send. The
adapters are otherwise structurally complete and ready for real credentials in a future
environment.

## Known limitations / follow-up

- No automatic recovery for a recipient stuck in `dispatching` after a process crash — documented
  above under "Idempotency model," not implemented, to avoid risking a duplicate send. A future
  ops runbook or Module 11 addition could add a time-boxed stale-`dispatching` reconciliation pass.
- Real Twilio/SES transmission was not exercised live (no credentials available) — config-level
  correctness only.
- No provider callback/webhook processing, no delivery-status polling, no Incident Command Center
  integration — all explicitly out of scope, deferred to Module 11+.

## Next module

Module 11 — Delivery Tracking.
