# Module 09 — Alert Engine

## Scope

The Alert Engine foundation: an Alert is a durable, auditable communication *plan* — channel,
content (Template-based or ad-hoc), recipient selection, resolved/deduplicated/eligibility-
checked recipients, and an immutable snapshot once approved. This module never sends anything
externally, implements no provider integration, no retry logic, and no delivery tracking — all
of that is explicitly Module 10/11's job.

## Alert architecture

`alerts` (the plan) → `alert_contact_selections` / `alert_group_selections` (DRAFT-time source
selections, live-editable) → `alert_recipients` (the resolved, immutable snapshot written once,
at READY). Source selections explain *intent*; recipient rows are the *actual resolved outcome*
at the moment READY happened. The two are deliberately separate tables (spec-required) rather
than overloading `alert_recipients` for both draft selection and final snapshot.

## Alert vs provider boundary

Grepped and confirmed empty: no Twilio/SES/SendGrid/SMTP/nodemailer references, no provider
message IDs generated, no retry logic, no delivery-receipt handling anywhere in
`backend/src/modules/alerts/`. `alert_recipients.status` is written only as `pending_delivery` —
the existing `queued/submitted/delivered/failed` values (Module 01's original schema) remain
structurally present, untouched, reserved for Module 10/11.

## Alert lifecycle

`DRAFT → READY`, `DRAFT → CANCELLED`, `READY → CANCELLED`. `CANCELLED` is terminal. No
`QUEUED`/`SENDING`/`SENT`/`FAILED` states are ever written by this module — those remain
Module 10/11's concern, and the `alerts.status` check constraint was extended (never replaced) to
add `ready`/`cancelled` alongside the pre-existing forward-compat values.

Since Module 10 doesn't exist yet, a READY Alert may still be cancelled — documented explicitly
as a constraint that **must be revisited** once real provider dispatch exists (a Ready-and-
already-dispatching Alert should not be silently cancellable at that point).

## Incident/standalone model

`alerts.incident_id` is nullable. A standalone Alert requires nothing extra. An Incident-linked
Alert is validated server-side at both creation and READY time: the Incident must exist and must
not be `closed` (`incident_not_eligible`, 400 at create if simply invalid/missing, 409 if it
exists but is closed). No Incident is ever auto-created for a standalone Alert.

## Channel model

One Alert = one channel (`sms` or `email`), per the spec's explicit preference over a
multi-channel Alert record — this simplifies rendering, recipient resolution, and (later)
provider dispatch/retry/tracking considerably. If an operator wants both SMS and Email for the
same event, they create two separate Alert records. This is a deliberate divergence from the
stakeholder prototype's demo-only "SMS + Email" combined wizard option; the module spec explicitly
directed the single-channel-per-Alert model, which takes precedence per this project's rules for
resolving spec-vs-prototype conflicts.

## Template vs ad-hoc model

`alerts.content_source ∈ {template, adhoc}`. Template-based: `templateId` required, channel must
match the Template's channel; the Template need not be `active` until READY (a DRAFT can
reference a not-yet-activated Template). Ad-hoc: `subject`/`body` live directly on the DRAFT
Alert row, validated with the exact same inert-content/allowlisted-placeholder rules Module 07
uses for Templates (`validateTemplateContent`, reused directly — not reimplemented).

## Recipient source model

Recipients resolve only from BEACON Contacts — individually selected, or via Group membership
expansion. Users are never notification recipients (Users are BEACON *operators*, not people
BEACON reaches externally — see CLAUDE.md's User/Contact separation). No dynamic Groups, no
automatic Incident-participant inclusion, no spreadsheet upload, no external directory — all
explicitly out of scope per the module spec.

## Group expansion/deduplication

`resolveRecipients()` (`backend/src/modules/alerts/recipientResolution.ts`) reuses Module 06's
`findGroupById`/`getGroupMemberContactIds` directly — no duplicated Group-membership logic. Every
selected Group is expanded to its member Contact ids; those ids are unioned with the direct
Contact selections and deduplicated via a `Set` keyed on Contact **id** — never on shared
email/phone (Module 04 deliberately allows two different Contacts to share a phone/email; this
module must never treat that as the same recipient). Live/integration-verified: `Contact A`
selected directly + `Group X (A,B,C)` + `Group Y (B,D)` → 4 unique recipients, 2 duplicate
selection-references collapsed.

## Eligibility/exclusion behavior

Only `active` Contacts with the destination the channel requires (`mobilePhone` for SMS, `email`
for EMAIL) are eligible. Everyone else is excluded with a reason (`inactive` or
`missing_channel`) — surfaced only as **counts** (never per-contact PII) in both the preview
response and the frozen `alerts.exclusion_summary` snapshot. An Alert can never become READY with
zero eligible recipients (`zero_eligible_recipients`, 409).

## Preview model

`POST /alerts/:id/preview` — DRAFT only, server-authoritative (ignores anything the browser might
compute), resolves current selections via the exact same `resolveRecipients()` function READY
uses, and renders sample content using Module 07's synthetic placeholder values
(`samplePlaceholderValues()` — "Alex Morgan", never a real Contact). This means preview never
needs `alerts.recipients.read`: it exposes counts and synthetic sample content only, never real
recipient identities or destinations. Preview persists nothing and never transitions status.

## READY snapshot model

`POST /alerts/:id/ready` runs as a single transaction: row-lock the Alert (`findAlertForUpdate`,
`SELECT ... FOR UPDATE`) and re-check `DRAFT`; if Incident-linked, row-lock and re-check the
Incident isn't closed; load the current Template (must be `active`) or the ad-hoc content already
on the Alert; re-resolve recipients from the *current* selections; reject if any selected Group
has gone inactive (`invalid_group_selection`, 409) or if eligible count is 0 or exceeds
`ALERT_MAX_RECIPIENTS`; render each eligible Contact's personalized content and bulk-insert
`alert_recipients` rows; freeze `alerts.subject`/`body`/`template_name_snapshot`/
`eligible_recipient_count`/`excluded_count`/`exclusion_summary`; set `status = 'ready'`,
`ready_at = now()`; append the Incident timeline event and the audit event (same transaction).
No partial READY state is possible — either every write commits or none does.

## Content snapshot verification

`alerts.body`/`alerts.subject` hold the **frozen source content** (placeholders still present,
e.g. `"Hello {{firstName}}"`) as of READY time — for Template-based Alerts, copied from the
Template's current `body`/`subject` at that instant; for ad-hoc Alerts, whatever was already on
the DRAFT row. This is distinct from the **per-recipient rendered** content
(`alert_recipients.rendered_subject`/`rendered_body`), which is the fully personalized final text
for each specific Contact. Live-verified: changed a Template's `body` after an Alert built from it
went READY — `GET /alerts/:id` continued returning the original frozen text.

## Destination snapshot verification

`alert_recipients.recipient_address` captures each eligible Contact's normalized phone/email at
the exact moment of READY. This is a deliberate, documented exception to this codebase's general
avoid-PII-duplication principle: if the Contact's phone/email changes after READY but before a
future Module 10 actually dispatches, the Alert must still reflect what was approved at
send-time. Live-verified: changed a Contact's `mobilePhone` after READY — the recipient row's
`recipient_address` (and `rendered_body`, since the name is also frozen) stayed unchanged, and a
concurrent Group-membership addition never altered the already-written recipient row set.

## Permission mapping

New codes: `alerts.read`, `alerts.create`, `alerts.update`, `alerts.ready`, `alerts.cancel`,
`alerts.recipients.read`.

| Role | Grants |
|---|---|
| ADMIN | all 6 |
| COMMUNICATION_MANAGER | all 6 |
| INCIDENT_COMMANDER | all 6 |
| AUDITOR | `alerts.read`, `alerts.recipients.read` (deliberate — Auditor's job is compliance review of BEACON's own communications) |
| RESPONDER | `alerts.read` only — `alerts.recipients.read` deliberately withheld; nothing in this role's job requires seeing destination PII |

## Recipient PII controls

`alerts.recipients.read` is a separate permission from `alerts.read`, gating only
`GET /alerts/:id/recipients` — the one endpoint that returns real destination phone/email.
Everything else (`GET /alerts`, `GET /alerts/:id`, preview) exposes counts, safe summaries, and
Contact *names* only (via `sourceContacts`/`sourceGroups` on the detail DTO, needed for DRAFT
audience-editing UX) — never phone/email. Live/integration-verified: RESPONDER gets `403` on the
recipients endpoint; AUDITOR gets `200`.

## APIs

`GET /alerts`, `GET /alerts/:id`, `POST /alerts`, `PATCH /alerts/:id` (DRAFT-only, replaces
`contactIds`/`groupIds` wholesale when provided), `POST /alerts/:id/preview`,
`POST /alerts/:id/ready`, `POST /alerts/:id/cancel`, `GET /alerts/:id/recipients`. All 5 mutating
routes call `requireCsrf`; all bodies use `additionalProperties: false`.

## Frontend

`frontend/src/alerts/`: `AlertsPage.tsx` (list, search/status/channel filters),
`CreateAlertModal.tsx` (title/channel/incident/content-source, initial audience deferred),
`AlertDetailModal.tsx` (Overview tab: details editing, Preview, explicit Ready confirmation
showing channel/incident/audience counts before committing, Cancel; Audience tab: Contact/Group
search-and-select against the live selection tables). Once READY or CANCELLED, all editing
controls are hidden/disabled and a clear status banner explains the state — the READY banner
explicitly states delivery is not yet implemented, never implying a message was sent.

## Incident timeline integration

`ALERT_CREATED`, `ALERT_READY`, `ALERT_CANCELLED` timeline events, written only when the Alert is
Incident-linked, with metadata limited to `{alertId, channel, eligibleRecipientCount,
excludedCount}` — never a destination, subject, or body. Live-verified via a full serialized-JSON
scan of the timeline response: no Contact name, email, or message text present anywhere.

## Audit/privacy review

No role-name checks, no `console.log`, no provider code (grep-confirmed empty). `ALERT_CREATED`/
`ALERT_UPDATED`/`ALERT_READY`/`ALERT_CANCELLED` audit events carry only ids/channel/counts/field
names — never rendered content or recipient identities (live-verified via a serialized-audit-row
PII scan). Mass-assignment blocked (forged `status`/`createdBy` silently ignored, matching the
established AJV-strips-unknown-props convention). 204 responses call `.send()`; CORS `methods`
includes PATCH/DELETE — both pre-existing project-wide fixes, re-verified working for this
module's routes in the live browser.

## Concurrency protections

The READY transaction row-locks both the Alert (`FOR UPDATE`) and, if linked, the Incident,
before doing anything else — a second concurrent READY attempt (or a concurrent Incident close)
sees the already-changed state and fails cleanly rather than racing. `alert_recipients` carries a
partial unique index on `(alert_id, contact_id) WHERE contact_id IS NOT NULL`, the database-level
duplicate-recipient guarantee, mirroring Module 08's `incident_participants` pattern.

## Database migration

`0009_fearless_princess_powerful.sql`: new `alert_number_seq` sequence; new
`alert_contact_selections`/`alert_group_selections` tables; `alerts` gains `alert_number`
(unique), `title`, `content_source`, `template_name_snapshot`, `eligible_recipient_count`,
`excluded_count`, `exclusion_summary`, `ready_at`, `cancelled_at`, and its `status`/`body` columns
were altered (`status` check extended to add `ready`/`cancelled`; `body` made nullable since
Template-based DRAFTs have no content until READY); `alert_recipients` gains `rendered_subject`/
`rendered_body`, its `status` check extended to add `pending_delivery`, and a new partial unique
index on `(alert_id, contact_id)`.

## Alert identifier strategy

`ALT-{year}-{6-digit}` via a new global `alert_number_seq` sequence — the same pattern as Module
08's `incident_number_seq` (lock-free `nextval()`, never reset per year). Chosen over omitting an
identifier because the prototype already displays alert reference numbers prominently (dashboard,
alert history, Incident Command Center), and consistency with the established Incident-number
scheme was judged more valuable than exactly matching the prototype's ad-hoc demo format.

## Configurable recipient limit

`ALERT_MAX_RECIPIENTS` env var (`backend/src/modules/alerts/config.ts`, default `5000` for
development), checked at READY time — exceeding it rejects with `recipient_limit_exceeded` (409).
Production can tune this via the environment; there is no vendor-specific hard-coded ceiling.

## Tests

Backend: 36 new tests in `backend/src/test/alerts/routes.integration.test.ts` (all passing on
first real run bar one status-code mismatch, fixed immediately), covering auth/RBAC, CRUD/
validation, standalone vs Incident-linked, Template vs ad-hoc, Group expansion/dedup, shared-
email/phone non-merging, exclusion reasons, zero-recipient rejection, preview non-persistence,
READY snapshot writing, Template/Contact/Group-change-after-READY immutability, inactive-
Template/Group READY rejection, CLOSED-Incident-race rejection, READY read-only enforcement,
cancellation lifecycle (including terminal CANCELLED), Incident timeline PII-free events, and
recipients-endpoint PII gating. Frontend: 6 new tests in `AlertsPage.test.tsx` plus 2 new
`App.test.tsx` nav-gating tests.

## Live PostgreSQL validation

Directly against `beacon_dev`: confirmed all new `alerts`/`alert_recipients` columns, the
`alert_number_seq` sequence, the two new selection tables and their indexes, and 34 permissions /
86 role-permission mappings (up from Module 08's 28/65), idempotent across repeated seeds.

## Live API workflow

Full curl-driven workflow: ADMIN login → create + activate an Incident → create a DRAFT
Incident-linked SMS Alert with Contact A direct + Group X + Group Y selected → preview (verified
4 unique / 2 eligible / 2 excluded with the exact expected inactive/missing-channel breakdown,
and 2 duplicate selections collapsed) → READY (verified counts, snapshot) → verified
`alert_recipients` rows and per-recipient rendered content → changed the Template body, a
Contact's phone, and Group X's membership → verified the READY Alert's content/recipients were
completely unaffected → verified the Incident timeline (`ALERT_CREATED`→`ALERT_READY`) and audit
rows contained zero PII → verified a READY edit attempt was rejected (409) → cancelled the Alert
→ created and readied a standalone Email Alert → verified the full RBAC matrix
(COMMUNICATION_MANAGER/INCIDENT_COMMANDER full access, AUDITOR read+recipients,
RESPONDER read-only-no-recipients, unauthenticated 401) → cleaned up all synthetic data,
verified via fresh row counts.

## Live browser workflow

Full workflow through the real React frontend: login → Alerts nav → list view with existing
alerts (correct badges/counts) → Create Alert (title, incident search-and-select, ad-hoc SMS
content) → real `POST /alerts` → Audience tab → Group search-and-add → real `PATCH /alerts/:id`
persisting the selection → Overview tab → Preview (real `POST /alerts/:id/preview`, correct
eligible/excluded counts and synthetic sample content with SMS segment estimate) → explicit Ready
confirmation panel (channel/incident/audience summary) → Confirm Ready (real
`POST /alerts/:id/ready`) → READY badge, frozen read-only content, explicit "delivery not
implemented yet" banner — never a fake "Sent" claim. All requests succeeded with proper CORS
preflights; only benign pre-login `401`s observed.

## lint / typecheck / build

All three workspaces (`database`, `backend`, `frontend`) — lint, typecheck, and build all pass
cleanly with zero errors/warnings.

## Known limitations / follow-up

- A READY Alert remains cancellable, since Module 10 dispatch doesn't exist yet to conflict with.
  **This must be revisited once Module 10 exists** — cancelling an Alert already mid-dispatch is
  a different, harder problem than cancelling one that's merely approved-but-unsent.
- `alert_number_seq`, like `incident_number_seq`, is a single global (not per-year) counter — the
  same deliberate tradeoff as Module 08, for the same reason.
- Preview's exclusion detail is counts-by-reason only, never a per-Contact list — a possible
  future enhancement gated behind `alerts.recipients.read`, not implemented now (avoids
  over-building beyond what this module's spec required).
- No Provider integration, delivery tracking, Incident Command Center, realtime Chat, War Room,
  or Guest invitation/OTP — all explicitly out of scope, deferred to Modules 10+.

## Module 10 handoff contract

A future Module 10 should query READY Alerts' recipients (`alert_recipients` where
`status = 'pending_delivery'`) and dispatch exactly what's stored — `channel`,
`recipient_address` (destination), `rendered_subject`/`rendered_body` (already personalized) —
without re-querying the current Contact or Template. It should never re-render, never re-resolve
membership, and should update `alert_recipients.status`/`provider_message_id`/`submitted_at`/
`delivered_at`/`failed_at`/`error_detail` — all columns already present and unused by this module.

## Next module

Module 10 — Notification Providers.
