# Module 20 — Audit

## Scope

A trustworthy, searchable, authorization-controlled Audit search API and frontend over the
existing `audit_logs` foundation (Module 01/02) — never a parallel or second audit system. This
module extends the write-side actor model (a real gap: Guest-initiated events were being
misattributed to `"system"`), adds bounded search/filter/pagination, a new `audit.read` permission,
and a frontend page. It does not touch the Incident timeline (`incident_timeline_events`, Module 08),
which remains a separate, deliberately distinct concept.

## Audit vs Incident timeline

Audit answers **who did what, to which resource, when, with what safe context** — a platform-wide
accountability record spanning every domain (auth, users, contacts, incidents, alerts, guests, war
room). The Incident timeline answers **what operationally happened during this Incident** —
scoped to one Incident, and already deliberately curated to avoid noise (Module 13's decision not
to log every chat message; Module 14/19's decision not to log every join/leave). The two write
paths already coexist in every relevant service function (e.g. `incidents/service.ts`'s
`removeParticipant()` writes both a `PARTICIPANT_REMOVED` timeline event and an
`INCIDENT_PARTICIPANT_REMOVED` audit event, deliberately with different event-type strings, in the
same transaction) — this module changes neither write path's existing behavior, only the audit
side's actor accuracy and adds the read/search surface.

## Existing audit foundation (inspected before any change)

`audit_logs` (Module 01): `id, event_type, actor_type, actor_id, incident_id, resource_type,
resource_id, metadata (jsonb), created_at`. `actor_id`/`resource_id` are deliberately not
foreign-keyed (the actor/resource can be a User, Guest, or absent entirely, and the log must
survive the referenced row being later modified). `recordAuthEvent()` (`auth/audit.ts`) was
already the single write helper, called from every relevant module (~30 call sites across Modules
02-19) — extended, not replaced.

## Actor model — the real gap this module closes

`actor_type`'s check constraint already allowed `'guest'`, but `recordAuthEvent()` had no way to
select it: `actorType: input.actorId ? "user" : "system"` inferred the type purely from whether an
`actorId` was present. Every Guest-initiated event (`GUEST_OTP_REQUESTED`,
`GUEST_VERIFICATION_SUCCEEDED`, `GUEST_VERIFICATION_FAILED_LIMIT`, `GUEST_SESSION_REVOKED`) never
passed a `actorId` at all (a Guest has no `users` row to reference), so every one of them was
silently recorded as `actor_type = 'system'` — a misattribution, not a deliberate "no known actor"
case. Fixed by adding an explicit optional `actorType` to `RecordAuthEventInput` (defaults to the
old inference for full backward compatibility with all existing call sites) and updating the four
genuinely-Guest-initiated call sites in `guestVerificationService.ts` to pass
`actorType: "guest", actorId: <the guest_invitations.id>` — the invitation row remains this
codebase's Guest identity anchor (Module 17's decision), so it's the only id a Guest actor can
safely reference. Manager-initiated Guest-related events (`GUEST_INVITATION_CREATED/SENT/REVOKED`,
`GUEST_ACCESS_REVOKED` via participant removal) were already correctly attributed to the acting
User and were left unchanged.

## Actor snapshot — deliberately not added

Actor display names are resolved at **read time** via a `LEFT JOIN` (to `users` when
`actor_type = 'user'`, to `guest_invitations` when `actor_type = 'guest'`, conditioned on
`actor_type` in the join's own `ON` clause since `actor_id` isn't a single-table FK) rather than
stored as a snapshot at write time. This means a User's later display-name change is reflected
retroactively in old audit rows — a deliberate choice: `incident_timeline_events` already
established this same "join at read time" pattern (`actorDisplayName: users.displayName`), and
introducing a snapshot column would be new, unjustified complexity for a cosmetic-only concern
(display name drift is not a security or accountability issue — the `actor_id` itself is the
permanent, accurate record). No email/phone is ever joined in.

## Resource model

`resourceType`/`resourceId` (already existing columns) are returned as-is — `{type, id}` only, no
resource-side display-name resolution (unlike the actor side), keeping the polymorphic-reference
handling to the one side that actually needs a human-readable name in the UI.

## Event coverage review

Reviewed every `recordAuthEvent()` call site across Modules 02-19 (~30 event types spanning auth,
users/RBAC, contacts, groups, templates, incidents, alerts, guests, war room). Coverage was already
comprehensive from each module's own build-out; no missing high-value event was found. Chat
messages remain deliberately un-audited (`chat_messages` is its own authoritative content history,
per the module spec's explicit instruction); War Room join/leave remain deliberately un-audited
per-action (Module 14's own established "avoid noisy per-action logging" decision, unchanged here).

## Metadata policy

Metadata was already server-built and allowlisted at every call site before this module (never a
raw request body, never an entire before/after object) — confirmed by inspection, not changed.
This module adds no new metadata-shape validation on the write side (already correct) and adds a
regression test asserting no banned pattern (`password`, `passwordHash`, `mfaSecret`,
`recoveryCode`, `rawToken`, `tokenHash`, `otp`, `guestSessionToken`, `authorization`, `cookie`,
`DATABASE_URL`) ever appears in a live multi-domain audit read, across the full write path this
module didn't change.

## Transactional integrity — inspected, not changed

Every high-value state-change call site already writes its audit event inside the same
`db.transaction()` as the business state change (Modules 08/17/18/19's established pattern) — this
module didn't need to introduce new transactional wiring, only verify (by inspection and the
existing regression suite) that this guarantee already holds everywhere it matters.

## Append-only protection

No `UPDATE`/`DELETE` method exists anywhere in `auditQueries.ts`/`auditService.ts`/`routes.ts` —
the only write path remains `recordAuthEvent()`'s `INSERT`. No DB-level trigger/role restriction was
added (the module spec explicitly cautions against adding deployment/test fragility for this); the
application-layer guarantee (no mutation route registered, test-verified) is the enforcement
mechanism, consistent with every other append-only table in this codebase
(`incident_timeline_events`, `notification_delivery_events`).

## Permission

New code: `audit.read` (`MODULE_20_PERMISSIONS`), a global (not `incidents.*`-nested) permission,
mirroring the existing `users.read`/`roles.read`/`permissions.read` global convention since Audit
spans every domain. AUDITOR — whose entire role description is "Read-only access for compliance
and audit review" — is the only non-ADMIN role granted it; INCIDENT_COMMANDER/
COMMUNICATION_MANAGER/RESPONDER are not, per the module spec's suggested conservative default and
this codebase's existing pattern of granting only what a role's established job justifies.

## Query/filter API

`GET /audit`, `audit.read`-gated. Filters: `eventType`, `actorType` (validated against
`user|guest|contact|system`), `actorId`, `resourceType`, `resourceId`, `incidentId`, `from`/`to`
(ISO 8601; `400` on an unparseable value or `from > to`), `cursor`, `limit` (schema-bounded
`1..100`, matching Module 13's chat-history `historyQuerySchema` convention exactly — a limit
above 100 is rejected, not silently clamped). No arbitrary/SQL-like filter syntax is ever accepted;
every filter is a plain equality (or range, for dates) condition built server-side from validated
input.

## Pagination

Keyset (cursor) pagination on `(created_at DESC, id DESC)`, not this codebase's usual
`page`/`pageSize` offset convention — a deliberate, documented deviation: Audit is a potentially
very large, always-newest-first, append-only table, exactly the case the module spec calls out as
warranting cursor pagination over an ever-growing `OFFSET`. The opaque cursor is a base64url-encoded
`{createdAt, id}` pair; a malformed cursor returns `400`. The frontend surfaces this as a "Load
more" forward-only control (no "jump to page N" or "previous page" — an accepted tradeoff of keyset
pagination, and simpler than implementing reverse-cursor traversal for a feature nothing in the
prototype or spec required).

## Indexes

Two new composite indexes added to the existing three (`created_at`, `event_type`, `resourceType +
resourceId`): `(actor_type, actor_id, created_at)` and `(incident_id, created_at)` — both back a
filter this API actually exposes, combined with the default newest-first sort every query performs
regardless of filter. No other index was added; `event_type` alone (already existing) was judged
sufficient for that filter combined with the primary `created_at` index for the common
unfiltered-by-actor/incident case.

## Frontend

`AuditPage.tsx` — a filter row (event type text match, actor type select, from/to date-time
pickers) over a table (Date/Time, Actor with a type badge, Action badge, Resource, Details),
matching the stakeholder prototype's Audit page column layout (`Date/Time | User | Action | Entity
| Details`) and its "Audit records are retained for accountability and cannot be deleted from this
application" footer copy verbatim. "Details" renders the already-allowlisted metadata as
`key: value` pairs — never a raw JSON dump, since the metadata itself is already curated
server-side. Wired into the app-shell nav (gated on `audit.read`, following the exact pattern
every other nav item already uses).

## Security findings / privacy review

- Guest cannot reach `/audit` at all — a Guest session cookie is never even the right cookie name
  for `authenticateUser()` to recognize (test-verified, mirroring Module 18's cross-mechanism
  cookie-rejection test).
- Filtering by `incidentId` does not bypass `audit.read` — the permission check runs before any
  filter is applied, and there is no `incidents.read`-based fallback path (test-verified).
- No secret/PII pattern was found in a live multi-domain audit read spanning auth, incident,
  guest-invitation, OTP, and War Room activity (test-verified via the banned-pattern regression
  sweep described above).

## Tests

Backend: 560 total (up from 540) — 20 new in `audit.integration.test.ts` (unauthenticated/
under-permissioned/Guest-cookie denial, AUDITOR/ADMIN allowed, no mutation route exists for any of
POST/PATCH/PUT/DELETE, Incident-filter still permission-gated, malformed-cursor/invalid-date/
from-greater-than-to/invalid-actorType all `400`, limit schema-bounded exactly like Chat's
convention, keyset pagination with no duplicates across pages and full coverage of a 5-event
scenario, User-actor and Guest-actor and system-actor attribution correctness, the
banned-metadata-pattern sweep, and resource-mapping correctness). The pre-existing
`rbac/permissions.test.ts` AUDITOR/union/ADMIN hardcoded arrays were updated for the new
`audit.read` permission (the established "cascading RBAC test fix" pattern this codebase's prior
modules also hit). Frontend: 103 total (up from 97) — 6 new in `AuditPage.test.tsx` (empty state,
row rendering with actor badge/action/resource/metadata, Guest-actor badge, cursor-based "Load
more", filter-triggered re-fetch, error banner).

## Live validation

Curl-driven against the running dev backend: `GET /audit` unauthenticated correctly returns `401`;
`DELETE /audit` and `POST /audit` both correctly return `404` (no such route exists at all, not
merely a `405`). The full authenticated search → filter → paginate → actor/resource-mapping
workflow is additionally exercised end-to-end by the 20-test live-database integration suite (real
Fastify app, real PostgreSQL).

## Known limitations / follow-up

- No export — the module spec explicitly disfavors adding one absent a clear existing requirement
  (additional PII/security surface); left for a future enhancement if ever needed.
- No detail/expand view beyond the inline "Details" column — metadata objects recorded by this
  codebase are already small and curated, so a separate detail fetch/modal wasn't judged to add
  value over the inline rendering.
- Keyset pagination is forward-only (no "previous page" or random page access) — an accepted,
  documented tradeoff of the cursor approach chosen for this table's scale characteristics.
- No retention/deletion policy or endpoint was implemented — per the module spec, retention is a
  production/governance decision explicitly out of scope here.

## Module 21 boundary

Module 21 (Dashboard & History) must not expose Audit's full event stream on the operational
Dashboard's "Recent Activity" section — that section should use curated, high-value operational
sources (Incident/Alert lifecycle events), not every login/OTP/permission-change security event.
Module 21's own History views (Incident History, Alert History) are separate from Audit and reuse
Modules 08/09/10/11's authoritative data directly, not this module's read path.
