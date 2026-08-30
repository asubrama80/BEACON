# Module 11 — Delivery Tracking

## Scope

Answers "what happened after the provider accepted the message?" Module 10 owns *submission*
only; this module owns everything after — provider-neutral delivery states, event correlation via
`providerMessageId`, Twilio/SES callback ingestion, a development-only mock-delivery simulation
path, a safe aggregate delivery summary, and completion detection. It does **not** query
Contact/Group/Template (grep-confirmed empty across `backend/src/modules/notifications/` and the
delivery-specific additions to `backend/src/modules/alerts/`), never re-renders content, never
resubmits provider messages, never creates a new recipient row for an unrecognized callback, and
never changes the frozen snapshot `destination`/`renderedSubject`/`renderedBody` written by
Module 09.

## Submission vs delivery model

Deliberately two separate fields on `alert_recipients`, never one conflated column:
`status` (Module 10 — `pending_delivery`/`dispatching`/`submitted`/`submission_failed`) and
`delivery_status` (this module — `pending`/`delivered`/`undelivered`/`bounced`/`failed`),
documented as "only ever meaningful once `status = 'submitted'`." SUBMITTED is never conflated
with DELIVERED anywhere in the codebase — grep-confirmed no code path sets `delivery_status` off
of a submission-only event.

## Delivery states

Provider-neutral: `pending` → one of four terminal states — `delivered`, `undelivered` (SMS),
`bounced` (Email), `failed` (either channel, e.g. permanent rejection). SMS never reports
`bounced`; Email never reports `undelivered` — enforced both server-side
(`CHANNEL_ALLOWED_DELIVERY_STATUS` in `backend/src/modules/alerts/service.ts`) and mirrored in the
frontend's mock-simulation button set.

## Event correlation model

Every webhook adapter and the mock-simulation path correlates purely by `(provider,
providerMessageId)` — `findRecipientByProviderMessageId`
(`backend/src/modules/notifications/deliveryQueries.ts`) — never by destination phone/email,
subject, or body. An uncorrelatable callback returns `unknown_recipient` and never creates a
recipient row (live and automated-test verified).

## Twilio callback architecture

`POST /webhooks/twilio/status` (`backend/src/modules/notifications/webhooks/twilioWebhook.ts`).
Status map: `queued`/`sending`/`sent`/`accepted` → `submitted` (recorded to history, but does not
advance `delivery_status`, which starts and stays `pending` until a real terminal outcome);
`delivered` → `delivered`; `undelivered` → `undelivered`; `failed` → `failed`. An unrecognized
status is acknowledged (200, `ignored_status`) without processing, so Twilio never retries
endlessly. `ErrorCode`, when present, becomes a safe `providerErrorCode`/`safeErrorSummary`
("Twilio error code N") — never a raw response body.

## Twilio signature verification

Hand-rolled (no full SDK, same minimal-dependency choice as Module 10's Twilio adapter):
`backend/src/modules/notifications/webhooks/twilioSignature.ts` — sort POST param keys, concatenate
`key+value` onto the exact externally-visible callback URL, HMAC-SHA1 with the account auth token,
base64, constant-time-compared via `timingSafeEqual`. The callback URL is built from configurable
`PUBLIC_BASE_URL` (never derived from arbitrary proxy headers) — required for the signature to
verify correctly behind any reverse proxy; see `.env.example`.

## SES/SNS event architecture

Documented honestly: SES does **not** post to this webhook directly. The real architecture is
SES → a Configuration Set's Event Destination → an SNS topic → `POST /webhooks/ses/events`
(`backend/src/modules/notifications/webhooks/sesWebhook.ts`). This module implements the SNS
ingestion endpoint and event mapping only — it does not stand up SES Configuration Sets or SNS
topics/subscriptions (out of scope; that is account-level AWS infrastructure). Event mapping:
`Delivery` → `delivered`; `Bounce` → `bounced` (with `bounceType`/`bounceSubType` as a safe
`providerErrorCode`/`safeErrorSummary`, `feedbackId` as the dedupe-relevant `providerEventId`);
`Reject` → `failed`. `Send`/`Open`/`Click`/other event types are acknowledged and ignored — SES
`Send` success is never treated as delivery.

## SNS message authenticity

`backend/src/modules/notifications/webhooks/snsSignature.ts` — only `SignatureVersion "1"`
(RSA-SHA1) is supported (SignatureVersion "2"/SHA-256 is a documented, unimplemented gap — cannot
be exercised without real AWS traffic). The signing certificate is fetched only from a
hostname-and-protocol-allowlisted URL (`https://sns.<region>.amazonaws.com/...`, checked *before*
any network request), then verified via Node's `crypto.createVerify`. `fetchCert` is an injectable
parameter (defaulted to a bounded, no-redirect `fetch`) so both the unit suite and this module's
webhook-route tests can supply a synthetic self-signed key/cert with zero real AWS traffic.

## SubscriptionConfirmation / SSRF

`SubscriptionConfirmation` and `UnsubscribeConfirmation` messages are acknowledged (200,
`subscription_ack_no_fetch`) **without ever fetching `SubscribeURL`** — this eliminates that SSRF
vector by construction rather than attempting a partially-tested allowlist-fetch that cannot be
verified against real AWS traffic in this environment. An operator must complete subscription
confirmation manually via the AWS Console/CLI in any environment that actually wires up a real SNS
topic. This is a stricter, more defensible security posture than an auto-fetch mechanism would be.

## Mock delivery simulation

`POST /alerts/:id/recipients/:recipientId/mock-delivery`
(`backend/src/modules/alerts/service.ts` `simulateMockDelivery` + `backend/src/modules/alerts/
routes.ts`) — performs zero external network communication and funnels through the exact same
`processDeliveryEvent()` every real webhook adapter uses, so there is no parallel business-logic
path to drift out of sync. Registered **only** when `nodeEnv !== "production"` (verified live: a
`buildApp()` instance built with `NODE_ENV=production` returns a plain 404 for this route — it does
not exist, not merely permission-denied). Requires `alerts.dispatch`. Rejects a channel-
inappropriate status (`400 invalid_delivery_status`) and a recipient that was never submitted
(`409 recipient_not_submitted`).

## Centralized event service

`processDeliveryEvent()` (`backend/src/modules/notifications/deliveryService.ts`) is the single
function every webhook adapter and the mock-simulation endpoint calls — correlate recipient →
compute dedupe key → insert-if-new event row → apply the monotonic-rank state update → check for
alert-level completion. No webhook route contains its own copy of this logic.

## Duplicate/idempotent event handling

Every event is deduped via a DB-unique `dedupe_key` on `notification_delivery_events`:
`{provider}:event:{providerEventId}` when the provider supplies a genuine event id (SES's
`feedbackId` for bounces; the mock endpoint's fresh per-call `mock-sim-{uuid}`), else a derived
`{provider}:msg:{providerMessageId}:{normalizedStatus}` composite (Twilio's standard callback has
no event-id field at all). `insertDeliveryEventIfNew` uses `onConflictDoNothing`; a genuine
provider retry with the identical event collapses to zero new rows and `processDeliveryEvent`
returns `"duplicate"` — no repeated state mutation, no repeated completion event. Verified in
`deliveryService.test.ts`, `twilioWebhook.test.ts`, and `sesWebhook.test.ts`, and live via curl
(identical Twilio-style repeated call → one history row, one state transition).

## Out-of-order and terminal-state semantics

`backend/src/modules/notifications/deliveryStatus.ts` — a deliberately simple monotonic-rank rule:
`pending` = rank 0, all four terminal states = rank 1; `delivery_status` is only updated when the
new status's rank is strictly greater than the current rank (`isProgression`). This single rule
provably satisfies every required scenario — a terminal state, once reached, never regresses to
`pending`/`submitted`; a duplicate or later-arriving lower-or-equal-rank event still gets recorded
to history (so the audit trail is never lossy) but never re-mutates the recipient's current state.
The rule is deliberately timestamp-independent: Twilio's standard status callback carries no event
timestamp at all, so trusting provider-supplied ordering was never a safe design option.

## Delivery event history

`notification_delivery_events` — append-only, one row per accepted (non-duplicate) event:
`alert_id`, `alert_recipient_id`, `provider`, `provider_message_id`, `provider_event_id`,
`dedupe_key` (unique), `raw_provider_status`, `normalized_status`, `occurred_at`, `received_at`
(BEACON ingestion time — always trustworthy even when a provider timestamp isn't), a safe
`provider_error_code`/`safe_error_summary`. Never stores phone/email/message body/subject/
credentials/the full raw callback payload — grep- and test-verified (`JSON.stringify` scans in
`deliveryService.test.ts` and the Twilio/SES webhook tests assert the destination never appears in
a stored event row).

## Alert delivery summary

Safe aggregate counts folded into the existing `GET /alerts/:id` response (no destination PII):
`total`, `submissionFailed`, `deliveryPending`, `delivered`, `undelivered`, `bounced`, `failed`,
plus a derived `overallStatus` (`pending`/`in_progress`/`complete`/`partial_failure`/`failed`) —
computed by `deriveOverallDeliveryStatus` in `backend/src/modules/alerts/dto.ts`. This aggregate is
conceptually separate from the Alert's own lifecycle `status` field (`draft`/.../`submitted`/...)
— they are never merged into one value, and the UI never claims "delivered" text unless the actual
counts back it up (verified via a live/automated check that `overallStatus` only reaches
`"complete"` once every submitted recipient has actually reached `delivered`).

## Completion detection

`markDeliveryCompletedIfDue` (`backend/src/modules/notifications/deliveryQueries.ts`) — a single
conditional `UPDATE alerts SET delivery_completed_at = now() WHERE delivery_completed_at IS NULL
AND EXISTS(...submitted recipients...) AND NOT EXISTS(...any submitted recipient still
pending...)`. Postgres row-level locking makes this the atomicity guarantee: whichever concurrent
`processDeliveryEvent` call actually flips the column from `NULL` is the only one that fires the
completion timeline/audit event — proven live under a repeated final-recipient callback (exactly
one `ALERT_DELIVERY_COMPLETED` event despite the duplicate) and in `deliveryService.test.ts`.
Completion may happen much later than submission and never blocks any API request from returning.

## Permission mapping

New code: `alerts.delivery.read` — gates recipient-level delivery *event history* detail only. The
safe aggregate `deliverySummary` requires no new permission; it rides on the pre-existing
`alerts.read`.

| Role | `alerts.delivery.read` |
|---|---|
| ADMIN | yes |
| COMMUNICATION_MANAGER | yes |
| INCIDENT_COMMANDER | yes |
| AUDITOR | yes |
| RESPONDER | no (gets the safe aggregate summary for free via `alerts.read`) |

## APIs

`GET /alerts/:id` — `AlertDetailDto.deliverySummary` (gated `alerts.read`, same as before).
`GET /alerts/:id/recipients` — recipient rows gain `deliveryStatus`/`deliveryUpdatedAt`/
`deliveredAt`/`providerDeliveryCode`/`deliveryErrorSummary` (still gated `alerts.recipients.read`
only — same PII-tier as Module 10's submission fields). `GET /alerts/:id/recipients/:recipientId/
delivery-events` — dual-gated `alerts.recipients.read` **and** `alerts.delivery.read`; returns
normalized event history, never destination PII (the recipient's own detail already carries that
under its own permission). `POST /alerts/:id/recipients/:recipientId/mock-delivery` — development/
test only, gated `alerts.dispatch`, CSRF-required. `POST /webhooks/twilio/status` and
`POST /webhooks/ses/events` — no session auth/CSRF (provider-signature authenticity instead),
isolated route registration (`backend/src/modules/notifications/webhooks/routes.ts`), 64KB body
limit, a 300/minute rate limit distinct from the human-login throttle.

## Frontend

`AlertDetailModal.tsx` gained a "Delivery Tracking" section (shown once submission has occurred)
with an overall-status badge and exact counts ("2 delivered, 1 undelivered, 1 failed") — never a
bare "delivered" claim without the counts that justify it. A new "Recipients" tab (shown only when
the user has `alerts.recipients.read`) lists Recipient/Channel/Submission/Delivery status/Last
update, with channel-appropriate status badges. When `import.meta.env.DEV` and the user has
`alerts.dispatch`, each `submitted` row gets simulate-delivery buttons, clearly labeled
"Development/Mock only — these buttons simulate a provider delivery callback. They never contact a
real notification provider and never appear in production." No WebSockets — the modal re-fetches
on every mutating action; a viewer can always reopen/refresh to see newer state.

## Incident timeline integration

Exactly one `ALERT_DELIVERY_COMPLETED` event per Alert (never one per recipient), metadata
`{alertId, deliveredCount, failedCount, bouncedCount, undeliveredCount}` — no PII. Live-verified
full sequence: `INCIDENT_CREATED → INCIDENT_ACTIVATED → ALERT_CREATED → ALERT_READY →
ALERT_DISPATCH_STARTED → ALERT_DISPATCH_COMPLETED → INCIDENT_RESOLVED → INCIDENT_CLOSED →
ALERT_DELIVERY_COMPLETED` — the completion event fires and is recorded even after the Incident has
already been resolved and closed.

## Audit/privacy review

Individual provider callbacks are **not** written to the global audit log — `notification_
delivery_events` is the technical history; only the Alert-level `ALERT_DELIVERY_COMPLETED`
significant event is audited, once. Grep- and test-confirmed: no destination, message content, or
raw payload in any audit row, timeline event, or delivery-event-history row. Webhook handlers log
only provider/providerMessageId/normalized-status/outcome — never phone/email/subject/body/
credentials/the raw callback body (confirmed via a live-captured request containing `To`/`Body`
fields whose values never appear in the resulting stored event row).

## CLOSED Incident behavior

`processDeliveryEvent`/`maybeCompleteDelivery` never check Incident status anywhere in the
delivery-processing path — the only Incident-related guard is whether the linked Incident record
still *exists*. Live-verified: an Alert linked to a since-resolved-and-closed Incident still
accepted a delivery callback, updated the recipient's state, and appended the completion timeline
event after closure.

## Cancellation behavior

Module 10 already forbids cancelling an Alert once dispatch has claimed any recipient
(`dispatch_already_started`), so a `submitted` recipient can never coexist with a `cancelled` Alert
through the ordinary API. The delivery-processing path itself does not special-case this, by
design — it never inspects `alerts.status` at all — so historical reality (a message already
accepted by the provider) is never erased even if the Alert row were `cancelled` through some other
path. Verified directly at the data layer: a dispatched Alert forced to `cancelled` via a direct
database update still accepted and correctly processed a subsequent mock-delivery callback.

## Recovery / crash-stranded follow-up

Unchanged from Module 10's documented limitation: a recipient stranded in `dispatching` after a
process crash is not automatically reclaimed. This module adds one relevant guarantee on top: *if*
a genuine provider callback later arrives for such a recipient with a matching
`providerMessageId` (i.e. the provider had, in fact, accepted the message before the crash), it is
processed normally — correlation is purely by `providerMessageId`, with no dependency on the
recipient's `status` value. Broader stale-`dispatching` reconciliation remains a Production
Readiness follow-up, not solved here.

## Database migration

`0011_stale_vulcan.sql`: new `notification_delivery_events` table (FKs to `alerts`/
`alert_recipients`, indexes on `alert_id`, `alert_recipient_id`, `(provider, provider_message_id)`,
a unique index on `dedupe_key`, a `normalized_status` check constraint); `alerts` gains
`delivery_completed_at`; `alert_recipients` gains `delivery_status` (+ check constraint + index),
`delivery_updated_at`, `delivered_at` (reused a previously-unused pre-existing column),
`delivery_failed_at` (documented as distinct from Module 10's submission-only `failed_at`),
`provider_delivery_code`, `delivery_error_summary`.

## Tests

Backend: 413 total (up from 355 at the start of this module). New: `deliveryService.test.ts` (8
direct tests — correlation, unknown-recipient safety, idempotent dedupe, out-of-order/terminal-
state protection, exactly-once completion under repeated terminal callbacks, exact partial-summary
counts, PII-free event history); `twilioWebhook.test.ts` (11 HTTP-level tests — invalid/missing
signature, the full Twilio status → normalized-status map, unrecognized-status ack, unknown-
MessageSid safety, duplicate-callback idempotency, no PII persisted from `To`/`Body`);
`sesWebhook.test.ts` (19 tests — synthetic-keypair SNS signature verification including a tampered-
message rejection and an untrusted-cert-URL rejection that never makes a network call, SES event-
type mapping unit tests, and HTTP-level SubscriptionConfirmation/ignored-type/invalid-signature/
Delivery/Bounce/Reject/unknown-recipient/duplicate coverage); `delivery.integration.test.ts` (18
tests — the safe `deliverySummary` on `GET /alerts/:id`, the dual-permission-gated delivery-events
endpoint, full RBAC and channel-appropriateness on the mock-delivery endpoint, its production-only-
404 registration check, CLOSED-Incident and force-cancelled-Alert callback processing, exactly-once
completion). Frontend: 51 total (up from 47); 5 new tests covering the Delivery Tracking section,
the Recipients tab (shown/hidden by permission), and the mock-delivery simulation flow.

## Live PostgreSQL validation

Directly against `beacon_dev`: confirmed `0011_stale_vulcan.sql` already applied (a
re-run of `db:migrate` was a clean no-op), and 36 permissions / role-mappings idempotent across two
consecutive `db:seed` runs (up from 35 at the start of this module — the one new permission is
`alerts.delivery.read`).

## Live mock SMS delivery workflow

Full curl-driven workflow against the real backend: created a 4-recipient SMS Alert → READY →
Dispatch (`4 submitted`) → confirmed all 4 recipients started at `submitted`/`pending` (never
falsely delivered) → simulated recipient 1 and 2 `delivered`, recipient 3 `undelivered` → confirmed
a channel-mismatch `bounced` attempt on an SMS recipient was rejected (`400
invalid_delivery_status`) → confirmed the midway `deliverySummary` showed exact partial counts
(`{total:4, delivered:2, undelivered:1, deliveryPending:1}`, `overallStatus:"in_progress"`,
`deliveryCompletedAt:null`) → simulated recipient 4 `failed` → confirmed completion
(`{delivered:2, undelivered:1, failed:1, deliveryPending:0}`, `overallStatus:"partial_failure"`,
`deliveryCompletedAt` set) → sent a duplicate terminal simulation for recipient 4 → confirmed state
stayed `failed` (no regression) and `deliveryCompletedAt` did not change (no second completion).

## Live mock Email delivery workflow

Created an Incident, activated it, linked and dispatched a 3-recipient Email Alert, then resolved
and **closed** the Incident before sending any delivery callbacks. Simulated `delivered`,
`bounced`, and (after confirming `undelivered` was correctly rejected as an Email-inappropriate
status) `failed` for the third recipient — all three callbacks processed successfully despite the
Incident being CLOSED. Final `deliverySummary`: `{delivered:1, bounced:1, failed:1,
overallStatus:"partial_failure"}`. Incident timeline confirmed exactly one `ALERT_DELIVERY_
COMPLETED` event, appearing after `INCIDENT_CLOSED` in sequence, with safe metadata and zero PII
(grep-scanned the full timeline JSON for the recipients' actual email addresses — none found).

## Duplicate-event validation

Live (see SMS workflow above) and automated (`deliveryService.test.ts`,
`twilioWebhook.test.ts`, `sesWebhook.test.ts`): a genuinely duplicate provider event (matching
dedupe key) is acknowledged safely, produces zero additional history rows, and causes zero
additional state mutation or completion events.

## Out-of-order validation

Automated only (`deliveryService.test.ts` — a `DELIVERED` event followed by an older-timestamped
`SUBMITTED`-equivalent event; a `BOUNCED` event followed by duplicate `BOUNCED` events): confirmed
the terminal state never regresses. Not additionally exercised through a live provider callback in
this environment — see "Real Twilio/SES callback status" below for why.

## Live browser validation

Full workflow through the real React frontend against the real backend: signed in, opened a
previously-dispatched SMS Alert, confirmed the Delivery Tracking section rendered the exact
"PARTIAL FAILURE" badge and count text matching the curl-driven state, opened the Recipients tab
and confirmed the "Development/Mock only" banner and per-recipient status badges matched exactly,
then created a fresh single-recipient Alert through curl, dispatched it, and — from the browser —
clicked the "delivered" simulate button and watched the Delivery Tracking section update live (no
manual reload) from "IN PROGRESS / 0 delivered, 1 pending" to "COMPLETE / 1 delivered" with a
completion timestamp. Confirmed via `GET /alerts/.../deliverySummary` as RESPONDER (a role with
neither `alerts.recipients.read` nor `alerts.delivery.read`) that the safe aggregate is still
visible while both `GET /alerts/:id/recipients` and the delivery-events endpoint correctly return
403. Network tab showed a clean CORS preflight (`OPTIONS → 204`) and `200` for the mock-delivery
`POST`, consistent with Module 06's established CORS pattern; no CSRF errors.

## Real Twilio/SES callback status

**Intentionally not performed**, consistent with Module 10's documented precedent. No real Twilio
or AWS SES/SNS credentials or infrastructure exist in this environment. Real providers also cannot
reach a `localhost` development server at all — genuine callback testing requires a publicly
reachable HTTPS endpoint (a deployed environment, or a tunnel) which this module deliberately does
not add (no Cloudflare/ngrok infrastructure introduced here, per the module's explicit
instructions). Twilio signature-verification and status-mapping correctness were instead verified
with self-computed HMAC signatures against a synthetic auth token (`twilioWebhook.test.ts`); SES/SNS
authenticity and event-mapping correctness were verified with a synthetic RSA keypair standing in
for AWS's signing certificate via the injectable `fetchCert` seam (`sesWebhook.test.ts`,
`snsSignature.ts`). The mock-delivery simulation endpoint remains the local/CI testing mechanism.

## Test count / results

Backend: 413/413 passing. Frontend: 51/51 passing.

## Lint / typecheck / build

All three workspaces (frontend, backend, database): lint clean, typecheck clean, build clean.

## Commit hash

See git log — commit `feat: implement BEACON delivery tracking`.

## Push status

Pushed to `origin/master`.

## Git status

Clean after commit — no stray temp validation scripts, no untracked live-validation data files.

## Limitations / follow-up

- SignatureVersion "2" (SHA-256) SNS messages are not supported — only version "1" (RSA-SHA1),
  documented in `snsSignature.ts`.
- SNS `SubscribeURL` is never auto-fetched (see "SubscriptionConfirmation / SSRF" above) — an
  operator must confirm any real SNS subscription manually.
- Real Twilio/SES callback delivery was not exercised against this environment — see "Real
  Twilio/SES callback status."
- Stale-`dispatching` recovery after a process crash remains unimplemented, per Module 10's
  original documented limitation; this module ensures a late-arriving genuine callback for such a
  recipient is still processed correctly, but does not proactively reconcile stuck recipients.
- No WebSocket-based live push for delivery updates — the frontend re-fetches after a mutating
  action; a viewer must reopen/refresh to see delivery progress from another actor's action.

## Next module

Module 12 — Incident Command Center.
