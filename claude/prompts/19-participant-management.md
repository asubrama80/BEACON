# Module 19 — Participant Management

## Scope

Unified Incident roster across three identity models (registered User, Contact, verified Guest),
auto-enrolling a just-verified Guest, Guest removal, and gating Module 13 Chat / Module 14 War Room
access on a verified Guest's own invitation capabilities. This is the module that closes the loop
Modules 17-18 opened: an invitation is no longer just a possession-and-OTP artifact — a verified
Guest now actually participates in the Incident.

## Unified roster, distinct identities

`incident_participants` (Module 08) already modeled `participant_type IN ('user','contact','guest')`
with a check constraint requiring exactly the matching identity column — this module is the first
to actually populate the `'guest'` branch. No new roster table was introduced; `ParticipantDto` grew
a `'guest'` variant (`displayName` = the invitation's `guestName`, `email`/`mobilePhone` always
`null`, `guestCapabilities`/`guestVerifiedAt` populated, `sourceStatus` `null` since a Guest has no
separate identity-level active/inactive state the way a User/Contact does).

## Auto-enrollment

`enrollVerifiedGuestParticipant()` (`incidents/service.ts`) is called from
`guestVerificationService.verifyOtp()` (Module 18) inside the **same transaction** as
`markInvitationVerified()`, gated on that function's own first-time-only return value — the module
spec's own recommended design ("successful guest verification automatically activates/creates
corresponding incident participant because invitation itself represents explicit participation
authorization"). Gating on first-time-only is deliberate: a later re-authentication (session
expired, Guest logs back in via a fresh OTP) must never resurrect a participant a manager has since
removed — test-verified (`guestParticipant.integration.test.ts`, "never a duplicate on re-auth").
Race-safety comes from a new partial unique index, `incident_participants_active_guest_idx`
(`UNIQUE (incident_id, guest_invitation_id) WHERE status != 'removed'`), mirroring the exact pattern
already used for the User/Contact variants — not from the pre-check alone.

## Removal revokes access

`removeParticipant()` (Module 08, extended) detects `participantType === 'guest'` and, in the same
transaction as the soft-removal, calls `revokeAllGuestSessionsForInvitation()` (Module 18's
`guest_sessions` table) and records a `GUEST_ACCESS_REVOKED` audit event. This is the actual
mechanism that makes removal *immediate*: `authenticateGuest()` looks up the session by its
(unchanged) cookie token, and a revoked session row simply no longer satisfies
`findActiveGuestSessionByTokenHash()`'s `revoked_at IS NULL` condition on the very next request —
no separate participant-status check needed in the auth hook itself. Removal is soft (status →
`'removed'`), never a hard delete — full history preserved, matching Module 08's existing
User/Contact removal semantics exactly.

## Chat integration

`chat_messages` (Module 01/13) already had `author_type IN ('user','guest')` with a check
constraint requiring `participant_id` (not a `users` row) for a `'guest'` author — zero schema
change needed. `chatQueries.insertMessage()` became a discriminated union
(`{authorType:'user', userId}` / `{authorType:'guest', participantId}`); a new
`sendGuestMessage()` in `chatService.ts` reuses the exact same validation/CLOSED-Incident logic as
`sendMessage()`. The WebSocket handler (`chatWebsocket.ts`) was refactored around a shared
`runConnection()` internal, parameterized by a small `ChatActor` interface (`canSend()`/`send()`) —
`createChatConnectionHandler()` (User) and `createGuestChatConnectionHandler()` (Guest) are now both
thin adapters over the identical connect/broadcast/rate-limit/backpressure machinery, rather than
two parallel implementations.

## War Room integration

`war_room_sessions` (Module 14) previously allowed a `participant_type = 'guest'` row with **no**
identity column requirement at all — a real gap, closed here by adding `guest_invitation_id`
(mirroring `incident_participants`' exact pattern) and tightening
`war_room_sessions_reference_check` to require it, plus a new partial unique index
(`war_room_sessions_active_guest_idx`) giving Guest joins the same DB-level duplicate-active-session
guarantee registered-User joins already had. `joinWarRoomAsGuest()`/`leaveWarRoomAsGuest()`
(`warRoomService.ts`) mirror `joinWarRoom()`/`leaveWarRoom()` exactly — still no RTC, no camera, no
microphone, no media token anywhere; the media area remains the Module 15 placeholder.

## Guest authentication surface, extended

Three new pieces in `guestVerification/guestAuth.ts` (Module 18's own module, extended here):
- `AuthenticatedGuest.participantId` — the roster row id, resolved fresh on every
  `authenticateGuest()` call via `findActiveParticipantByGuestInvitation()`. An absent active row
  here is the removal case (see "Removal revokes access"), not a race — removal already revokes the
  session eagerly, so a request reaching this far always has *some* active participant.
- `requireGuestCapability(capability)` — the Guest-context equivalent of `rbac/guard.ts`'s
  `requirePermission()`, reading the invitation's own capability toggles rather than RBAC (a Guest
  never holds a permission code).
- `requireGuestIncidentMatch` — rejects any `:id` route param that doesn't equal the Guest's own
  `incidentId`, so a Guest can never widen their own scope by supplying a different Incident id in
  the URL. Test-verified for both Chat and War Room ("Incident scope isolation").

A Guest CSRF pair (`beacon_guest_csrf`/`x-guest-csrf-token`, Module 18) now actually gets used —
War Room join/leave require it, exactly like every other mutating route in this codebase requires
its own CSRF pair.

## Guest capability gating, no RBAC

| Capability | Chat | War Room |
|---|---|---|
| Granted via | `guest_invitations.permissions.chat` | `guest_invitations.permissions.warRoom` |
| Checked by | `requireGuestCapability("chat")` | `requireGuestCapability("warRoom")` |
| Ceiling | Set once at invite time (Module 17); this module never edits it | Same |

Deliberately conservative, per the module spec's own guidance ("do not add arbitrary capability
escalation unless explicitly required"): no capability-editing UI/API was added. A manager who wants
to change a Guest's access must revoke and re-invite.

## APIs

Guest-facing (all `authenticateGuest` + `requireGuestIncidentMatch`, all Guest-CSRF-required for
mutations):
- `GET /ws/guest/incidents/:id/chat` (+ `requireGuestCapability("chat")`) — WebSocket.
- `GET /guest/incidents/:id/chat/messages` — history; only requires a valid session, not the `chat`
  capability specifically (mirrors a read-only registered User still being able to read history).
- `GET /guest/incidents/:id/war-room` / `POST .../join` / `POST .../leave` (all +
  `requireGuestCapability("warRoom")` — there is no separate "read-only War Room" capability).

Authenticated-manager-facing: no new endpoints — `DELETE /incidents/:id/participants/:participantId`
(Module 08) now transparently handles a Guest participant via the same `removeParticipant()` path,
gated by the same existing `incidents.participants.manage` permission (no new permission code was
added, per the module spec's explicit "avoid unnecessary new permissions" guidance).

## Frontend

The Incident detail Participants roster (`IncidentDetailModal.tsx`) now renders a "Guest" badge
next to a Guest's display name, a "Guest" type column, a capability-chip list (Chat/War Room)
instead of contact info, and a Verified/Not-yet-verified status badge — the existing Remove button
already works unmodified, since it just calls the same generic delete endpoint.

`GuestLandingPage.tsx`'s "verified" phase (previously a placeholder) now renders
`GuestChatPanel.tsx`/`GuestWarRoomPanel.tsx` conditionally on the session's own
`capabilities.chat`/`capabilities.warRoom`. `useChatSocket.ts` (Module 13) was generalized to accept
optional `listMessages`/`socketUrl` functions (defaulting to the registered-User endpoints) so the
Guest panel reuses the exact same connect/reconnect/backoff hook rather than a parallel
implementation — `GuestChatPanel.tsx` is a thin, mostly presentational wrapper.

## Security matrix (verified by `guestParticipant.integration.test.ts`)

| Guest attempt | Result |
|---|---|
| Access another Incident's Chat/War Room with a valid session | 403 (`requireGuestIncidentMatch`) |
| `GET /users`, `/contacts`, `/incidents` with the Guest session cookie | 401 (wrong cookie name entirely — `authenticateUser` never recognizes it) |
| `DELETE /incidents/:id/participants/:id` (manage the roster) | 401 (no `authenticateUser`-equivalent path exists for a Guest at all) |
| Chat/War Room without the specific capability granted | 403 |
| Any access after being removed from the roster | 401 (session eagerly revoked) |
| Any access after Incident closure | 401 (`authenticateGuest()`'s existing Module 18 check) |

## Concurrency

`guestParticipant.integration.test.ts` covers: exactly-one participant row on first verification,
no duplicate on re-authentication, a duplicate War Room join staying at `activeSessionCount: 1`. The
genuinely-concurrent double-verification race (two simultaneous correct-code submissions) was
already covered by Module 18's own test suite; this module didn't need to add a new race test for
it since the auto-enrollment path inherits that same transaction's atomicity.

## Database migration

`0017_blue_warbound.sql`: adds `war_room_sessions.guest_invitation_id` + its FK (name-length
verified: 37 bytes) and tightened check constraint, plus both new partial unique indexes. Applied
against tables confirmed empty (`war_room_sessions`: 0 rows, `incident_participants`: 0 rows) before
migrating.

## Tests

Backend: 540 total (up from 518) — 22 new in `guestParticipant.integration.test.ts` covering
auto-enrollment (row creation, roster display, no-duplicate-on-reauth, no-users-row), removal
(immediate session invalidation, soft-delete history preservation, audit events), Incident-closure
revocation, Guest Chat (send+persist with `participantId` authorship, User-visible Guest label,
capability denial, no-cookie rejection, cross-Incident rejection, CLOSED-Incident denial, history-
read-needs-only-a-session), Guest War Room (join+persist with `guestInvitationId`, idempotent
duplicate join, leave, capability denial, cross-Incident rejection, CLOSED-Incident denial), and
security isolation (Guest cookie rejected on every registered-User-only surface, Guest cannot manage
participants). Frontend: 97 total (up from 92) — 2 new in `GuestChatPanel.test.tsx`, 3 new in
`GuestWarRoomPanel.test.tsx`; existing `ChatPanel`/roster tests continue passing unmodified against
the extended (backward-compatible) DTOs.

## Live PostgreSQL validation

`0017_blue_warbound.sql` confirmed applied (re-running `db:migrate` was a clean no-op); 45
permissions confirmed idempotent across two consecutive `db:seed` runs (unchanged from Module
18 — this module added no new permission codes, per its own "avoid unnecessary new permissions"
guidance).

## Live mock/E2E validation

The full auto-enrollment → Chat → War Room → removal → CLOSED-Incident workflow is exercised
end-to-end by the 22-test live-database integration suite (real Fastify app, real WebSocket server,
real PostgreSQL). Additionally validated live via curl against the running dev backend
(`GET /guest/incidents/:id/chat/messages` and `GET /guest/incidents/:id/war-room` both correctly
return `401` with no session).

## Live browser validation

Logged in as an ADMIN, created a synthetic Incident, and used the real Guest Invitations tab UI to
invite a guest with both `chat`/`warRoom` capabilities granted — the roster then showed the Guest
row with a "Guest" badge and capability chips exactly as designed. Opened the resulting
`/guest/invite/:token` link in a second browser tab: the public landing page rendered the correct
Incident context and masked destination, "Begin Verification" successfully requested a real OTP
against the live backend ("Code sent to b\*\*\*...@example.invalid"), and submitting a wrong code
correctly showed the inline "That code is incorrect." error without disclosing the real one. Full
OTP completion could not be driven from this live (non-test) session — by design, the raw code
exists nowhere retrievable outside the test-only capture seam (`onOtpGenerated`, Module 18), which
is deliberately absent from the real `buildApp()` path; the complete verify → Chat → War Room flow
is instead validated by the automated integration suite above, which exercises the identical code
path with that seam attached.

## Known limitations / follow-up

- No capability-editing UI/API — a manager must revoke and re-invite to change a Guest's granted
  capabilities, per the module spec's explicit conservatism guidance.
- The Guest portal's War Room panel has no realtime "who else is here" push — it only reflects
  `activeSessionCount` as of the last fetch/action, the same limitation the registered-User
  `WarRoomPanel.tsx` already has (no WebSocket transport exists for War Room presence, unlike Chat).
- A tab closing uncleanly is not detected for a Guest's War Room session, same as for a registered
  User (Module 14's existing documented limitation) — the session stays `joined` until an explicit
  Leave or the room is Ended.

## Module 20 boundary

Modules 15/16 (Audio/Video, Screen Sharing) remain deliberately deferred — nothing in this module
introduces an RTC SDK, camera/microphone access, or a provider decision. Module 20 is not started.
This concludes the Modules 17→18→19 unattended-execution sequence.
