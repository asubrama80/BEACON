# Module 17 — Guest Invitations

## Scope

The Guest invitation domain: creation, secure token issuance, notification delivery (reusing
Module 10's provider abstraction), lifecycle, expiry, revocation, and the public pre-verification
landing page. Deliberately does **not** implement OTP verification (Module 18) or roster/War
Room/Chat integration for a verified Guest (Module 19) — this module only gets a Guest as far as
"holds a valid, unverified invitation link."

## Guest vs User boundary

A Guest invitation never creates a `users` row, never assigns a role, never touches
`user_roles`, and is never checked by `requirePermission()`. Grep-confirmed: nothing in
`backend/src/modules/guestInvitations/` imports `users` for a write, and the integration suite's
"creates no users row and assigns no role" test asserts the `users` table row count is unchanged
by invitation creation. The entire lifecycle lives on the pre-existing `guest_invitations` table
(Module 01/08) — no new identity table was introduced (see "Identity model" below).

## Identity model — reusing `guest_invitations` as the identity anchor

Module 08 already added `incident_participants.guest_invitation_id` (with a check constraint
requiring it, and only it, when `participant_type = 'guest'`) before this module began — meaning
Module 08 had already established "the invitation row IS the Guest identity" as this codebase's
pattern. This module continues that pattern rather than introducing a separate `incident_guests`
identity table: once OTP-verified (Module 18), a Guest's identity is still just this same
`guest_invitations` row, referenced the same way `incident_participants` already references it.
This keeps Module 18's `guest_sessions` and Module 19's `war_room_sessions`/`chat_messages`
guest-authorship extensions minimal — see each of those modules' own docs once written.

## Token security

`generateInvitationToken()` (`token.ts`) mirrors `auth/session.ts`'s session-token pattern exactly:
`randomBytes(32).toString("base64url")` for the raw value, SHA-256 hex for the stored hash. The raw
token exists only transiently — inside the `invitationUrl` string returned once by
`createInvitation()` — and is never logged, never re-derivable from its hash, and never present in
any authenticated API response (`GuestInvitationDto` carries no token/hash field at all).
Live/test-confirmed: the row persisted in `guest_invitations.token_hash` never equals or contains
the raw token; `guest_invitations_token_hash_idx` is a real unique index (belt-and-suspenders
against a theoretical hash collision), backing the public lookup's query.

## Invitation URL

`buildInvitationUrl()` (`guestNotify.ts`) uses a dedicated `GUEST_PORTAL_BASE_URL` config value —
**deliberately distinct** from Module 11's `NotificationConfig.publicBaseUrl`, which is the
*backend* API's own externally-visible URL (used only to build the Twilio webhook callback). A
guest invitation link opens in a browser against the *frontend* web app, a different origin in
local development (Vite `:5173` vs. Fastify `:4000`); reusing the backend's base URL would build a
link that 404s. When `GUEST_PORTAL_BASE_URL` is unset, the link falls back to a relative path
(`/guest/invite/{token}`), per the module spec's explicit "dev may return a safe relative path"
allowance.

## Duplicate-invitation race safety

Two partial unique indexes — `guest_invitations_active_email_idx` and
`guest_invitations_active_mobile_idx`, each `UNIQUE (incident_id, destination) WHERE status IN
('pending','sent') AND revoked_at IS NULL AND destination IS NOT NULL` — are the real
race-safety guarantee for two concurrent invitation requests to the same destination on the same
Incident; a service-layer pre-check inside the same `db.transaction()` (mirroring Module 08's
participant-add pattern) produces a clean `409 invitation_already_active` in the common,
non-racing case. A revoked or expired invitation never blocks re-inviting the same destination —
the indexes are scoped to only the active statuses.

## Lifecycle

`pending → sent → verified → joined`, with `revoked`/`expired` reachable from `pending`/`sent`.
Module 17 only ever writes `pending`→`sent` (on successful mock-provider delivery) or →`revoked`
(explicit revoke); `verified`/`joined` are exclusively Module 18/19's responsibility — this module
never marks either.

## Expiry

`GUEST_INVITATION_TTL_HOURS` (default 24) is read once at invitation-creation time into a stored
`expires_at` timestamp — server-enforced on every read (`getPublicInvitation()` checks
`expiresAt.getTime() < Date.now()`), never client-trusted.

## CLOSED Incident rule

Creation is rejected outright on a CLOSED Incident (`409 incident_closed`). An invitation created
before closure becomes unusable at closure time via runtime validation in the public lookup
(`incident_not_eligible`) — no eager DB update is performed, matching the module spec's explicit
"runtime validation is fine" allowance.

## Revocation

`revokeInvitation()` is a conditional `UPDATE ... WHERE revoked_at IS NULL`, so a second revoke
call is a safe no-op (not an error) rather than double-writing `revoked_at`/audit events — the same
idempotent-revoke shape used elsewhere in this codebase. Revocation never hard-deletes the
invitation row; full history is preserved.

## Notification architecture

`guestNotify.ts` is a small, purpose-built sender — it calls `getSmsProvider(config).send()` /
`getEmailProvider(config).send()` directly (Module 10's exact abstraction), bypassing the entire
Alert Engine (recipient resolution, dispatch attempts, delivery tracking) and creating no Alert
record. A guest invitation is a single direct message to a single explicit destination, not a
broadcast to a resolved audience, so borrowing Alert Engine machinery would misrepresent both Alert
history and the Incident timeline. `SMS_PROVIDER=mock`/`EMAIL_PROVIDER=mock` work with zero extra
wiring; delivery failure is non-fatal — the invitation stays `pending` (rather than advancing to
`sent`) but remains valid and usable if the guest obtains the link by any other means.

## Capabilities

`GuestInvitationCapabilities { chat: boolean; warRoom: boolean }` — explicit foundation-only
toggles stored in the existing `guest_invitations.permissions` jsonb column, never translated into
an RBAC role or permission grant. Module 19 is responsible for actually gating Chat/War Room access
on these values once a Guest is verified; this module only records the manager's stated intent at
invite time.

## Permissions

New codes: `incidents.guests.read`, `incidents.guests.invite`, `incidents.guests.revoke`.

| Role | read | invite | revoke |
|---|---|---|---|
| ADMIN | yes | yes | yes |
| INCIDENT_COMMANDER | yes | yes | yes |
| COMMUNICATION_MANAGER | yes | yes | yes |
| RESPONDER | yes | no | no |
| AUDITOR | yes | no | no |

RESPONDER is read-only — consistent with its existing exclusion from every other
`*.manage`/`*.invite`/`*.revoke`-style permission in this codebase.

## APIs

Authenticated (`routes.ts`): `GET /incidents/:id/guest-invitations` (`guests.read`),
`GET /incidents/:id/guest-invitations/:invitationId` (`guests.read`),
`POST /incidents/:id/guest-invitations` (`guests.invite`, CSRF-required, returns the raw
`invitationUrl` — the one and only time it is ever exposed),
`POST /incidents/:id/guest-invitations/:invitationId/revoke` (`guests.revoke`, CSRF-required).

Public (`publicRoutes.ts`, no session, no CSRF, rate-limited 30/min):
`GET /guest/invitations/:token` — returns `{valid, reason?, incidentNumber?, incidentTitle?,
guestName?, maskedDestination?}` only. Never exposes the inviter, other participants, the full
destination, the token hash, or an internal id beyond the invitation id the token itself already
proves possession of. An unknown token, a malformed token, and (deliberately) most other rejection
reasons all return the same safe `200 {valid:false}` shape rather than a 404 — no enumeration
signal beyond the one documented `reason` field.

## Frontend

`GuestInvitationsPanel.tsx`, wired into `IncidentDetailModal.tsx` as a new "Guest Invitations" tab
(shown only with `incidents.guests.read`). Create form (name, email/phone, chat/War Room capability
checkboxes), a status-badged list, and a Revoke action gated on `incidents.guests.revoke`. The raw
invitation URL is shown exactly once, in a dismissible banner labeled **"DEV ONLY"** immediately
after creation — this deployment has no real SMS/email delivery, so a tester needs some way to
obtain the link; the token hash is never rendered anywhere.

`GuestLandingPage.tsx` is the public pre-verification page at `/guest/invite/:token`. Since this
codebase has no routing library (`main.tsx` renders `<App/>` directly), `App.tsx` checks
`window.location.pathname` against `/^\/guest\/invite\/(.+)$/` **before** rendering
`AuthProvider`/`AppShell` at all — a guest has no BEACON session at this point, so the landing page
is a wholly separate render tree, never wrapped in the authenticated shell. It calls the public
lookup endpoint and renders the safe minimal fields; the "Begin Verification" button is present but
disabled (Module 18 owns actually wiring it up).

## Audit and timeline

Audit: `GUEST_INVITATION_CREATED`, `GUEST_INVITATION_SENT` (only on confirmed mock-provider
delivery), `GUEST_INVITATION_REVOKED` — metadata carries only `channel`/`capabilities`, never the
token, destination, or OTP. Timeline: one `GUEST_INVITED` event per invitation (no destination
PII) — revocation is deliberately audit-only, not timeline-spammed, matching this codebase's
existing "Audit for management actions, Timeline for Incident-significant events" split.

## Security

Grep-confirmed: no `console.log` of a raw token anywhere in `guestInvitations/`; no role-name
checks (`requirePermission()` only); every mutating route CSRF-checked; the public route has
neither. Never exposes a token/token-hash field in any response body (asserted directly by both the
backend integration suite and the frontend panel test). Live/test-confirmed no `users`/`user_roles`
row is ever created by this module.

## Database migrations

`0014_sticky_wallflower.sql`: adds `guest_invitations.revoked_by_user_id` (FK to `users`, distinct
from the existing `invited_by`) and the unique index on `token_hash`. `0015_thick_crusher_hogan.sql`:
adds the two partial unique indexes backing race-safe duplicate-invitation detection (see
"Duplicate-invitation race safety"). Both applied against an empty `guest_invitations` table,
confirmed via a direct row-count check before migrating.

## Tests

Backend: 490 total (up from 463 at the start of this module) — 4 new in `token.test.ts` (entropy,
deterministic hashing, uniqueness, one-way) and 23 new in
`guestInvitations.integration.test.ts` (creation + raw-token-never-persisted, no-token-in-response
across list/get, destination normalization, invalid-destination rejection, no-destination
rejection, no-users-row-created, CLOSED-Incident rejection, duplicate-active-invitation rejection,
re-invite-after-revoke, mock-provider-only delivery, idempotent-safe revoke, history preserved on
revoke, public lookup for valid/unknown/revoked/CLOSED-Incident invitations, no-auth/no-CSRF on the
public route, the full read/invite/revoke permission matrix, authentication requirement, and
audit/timeline event presence without PII). Frontend: 102 total (up from 89) — 9 new in
`GuestInvitationsPanel.test.tsx` (permission gating, empty state, list rendering, create + dev-only
link display, no-tokenHash-in-DOM, revoke, revoke-permission gating, closed-Incident hides invite)
and 4 new in `GuestLandingPage.test.tsx` (valid-invitation rendering, expired/unknown generic
messaging, disabled Begin-Verification action).

## Live PostgreSQL validation

Both migrations confirmed applied against an empty `guest_invitations` table (verified via a direct
row-count query before each); a re-run of `db:migrate` afterward was a clean no-op. 45 permissions
confirmed idempotent across two consecutive `db:seed` runs (up from 42 — the three new codes are
`incidents.guests.read`/`invite`/`revoke`).

## Live mock/E2E validation

Full curl-driven validation against the running dev backend: an unknown token correctly returns
`200 {"valid":false,"reason":"not_found"}` (never a 404, never distinguishing "malformed" from
"doesn't exist"); the authenticated management endpoint correctly rejects an unauthenticated
request with `401`. The full authenticated create → verify-no-raw-token-persisted →
public-lookup → revoke → CLOSED-Incident-rejection → duplicate-invitation-race-guard workflow is
additionally exercised end-to-end by the 23-test live-database integration suite (same Fastify app,
same live PostgreSQL instance, invoked through the framework's HTTP-level `inject()` harness rather
than a raw socket).

## Known limitations / follow-up

- No resend action — a manager must revoke and re-invite rather than rotating the token on an
  existing invitation; the module spec explicitly permitted skipping this ("if unnecessary for
  MVP, don't implement").
- The public landing page's "Begin Verification" button is present but disabled — Module 18 owns
  wiring it into the actual OTP request/verify flow.
- No SPA-fallback web-server config (e.g. an Nginx `try_files` rule) was added for
  `/guest/invite/:token` in a production deployment — the Vite dev server's built-in history-API
  fallback already serves it correctly for local development and live validation; a production
  reverse-proxy config is deployment-infrastructure scope, not introduced here per this session's
  "do not introduce unnecessary infrastructure" rule.

## Module 18 boundary

Module 18 (OTP Verification) picks up exactly where this module stops: an unverified invitation
with a resolved, safe public projection and a disabled "Begin Verification" button. Module 18 owns
the OTP challenge table, guest session issuance, and marking the invitation `verified`; it must not
re-implement invitation token validation (`getPublicInvitation()`'s reason codes already cover
expired/revoked/CLOSED-Incident/already-used) and should call into this module's existing
`findPublicInvitationByTokenHash`-style lookup rather than duplicating it.
