# Module 14 — War Room Foundation

## Scope

The War Room domain model, lifecycle, access authorization, join/leave session tracking, and UI
shell — deliberately **provider-neutral**. This module does not choose or integrate a real RTC
vendor, install any RTC SDK, request camera/microphone access, issue a meeting URL or media token,
or transmit audio/video. Module 15 (explicitly out of scope here) is where a provider decision and
real media integration happens.

## Provider-neutral architecture

Grep-confirmed empty across `backend/src/modules/warRoom/` and `frontend/src/warRoom/`: no
Agora/LiveKit/Twilio-Video/Daily SDK reference, no `getUserMedia`/`RTCPeerConnection`/
`mediaDevices` call, no meeting-URL/media-token/provider-name field anywhere in the schema, DTOs,
or API responses. The frontend's media area is a fixed text placeholder
("Audio/video becomes available in Module 15.") — never a fake video tile or simulated participant
media state.

## Lifecycle

`NOT_STARTED → OPEN → ENDED`. `NOT_STARTED` is deliberately **not** a stored value — it is the
absence of any `incident_war_rooms` row for that Incident. A row is only ever created once a room
is actually opened, with `status = 'open'`; ending it flips the same row to `status = 'ended'`
(rows are never deleted, preserving full history). Opening again after an end creates a genuinely
new row — the partial unique index `WHERE status = 'open'` only ever constrains the *current* open
room, not historical ones.

## Room schema

`incident_war_rooms`: `id`, `incident_id`, `status` (`open`/`ended`), `opened_by_user_id`,
`opened_at`, `ended_by_user_id`, `ended_at`. No meeting URL, no provider room id, no media token —
see "Provider-neutral architecture". A partial unique index on `(incident_id) WHERE status = 'open'`
is the actual duplicate-open guarantee (not just a service-layer pre-check).

## Participant-session schema

`war_room_sessions`: `id`, `war_room_id`, `participant_type` (`user`/`guest`, only `user` is ever
written by this module), `user_id` (nullable — future-Guest-compatible), `incident_participant_id`
(optional cross-reference, nullable), `status` (`joined`/`left`), `joined_at`, `left_at`. A partial
unique index on `(war_room_id, user_id) WHERE status = 'joined'` makes repeated Join
database-level-idempotent, not just service-layer-idempotent.

## Incident Participant vs War Room session

Two genuinely separate concepts, kept in two separate tables. Being on an Incident's roster
(`incident_participants`, Module 08) never implies having joined its War Room, and joining a War
Room never auto-adds someone to the Incident roster. `war_room_sessions.incident_participant_id`
is an optional cross-reference only, populated by neither insert path in this module (left `NULL`)
— a future module could wire it up without a schema change.

## Permissions

New codes: `incidents.war_room.read`, `incidents.war_room.manage` (open/end), `incidents.war_room.join`
(join/leave) — three separate codes, mirroring how `incidents.lifecycle.manage` is already separate
from `incidents.read` elsewhere in this codebase.

| Role | read | manage | join |
|---|---|---|---|
| ADMIN | yes | yes | yes |
| INCIDENT_COMMANDER | yes | yes | yes |
| COMMUNICATION_MANAGER | yes | no | yes |
| RESPONDER | yes | no | yes |
| AUDITOR | yes | no | no |

COMMUNICATION_MANAGER deliberately does not get `manage` — mirrors its existing exclusion from
`incidents.lifecycle.manage`; opening/ending a War Room is an Incident-Commander-level operational
decision in this codebase's existing role model, not invented fresh for this module.

## Join eligibility

Authenticated + `incidents.war_room.join` + Incident not CLOSED + room currently OPEN. Deliberately
does **not** additionally require the joiner to already be on the Incident's participant roster —
per the module spec's explicit fallback ("if row-level security is ambiguous, retain the current
global permission model"), since no row-level "assigned incident" concept exists anywhere in this
codebase yet (Modules 08 through 13 are all global-permission-gated the same way). Documented here
as the chosen behavior, not an oversight.

## Prejoin flow

`WarRoomPanel.tsx` shows a two-step flow: clicking "Join War Room" opens an inline prejoin
confirmation (Incident number/title, "Joining as {display name}", an explicit note that
audio/video isn't available in this module) with Cancel/Join actions, before the actual join API
call fires. No camera/microphone permission is requested at any point — live-verified (no
`getUserMedia` prompt, no `<video>` element ever present in the DOM).

## Open / join / leave / end

- **Open** (`openWarRoom`): rejected on a CLOSED Incident (`409 incident_closed`) or an
  already-open room (`409 war_room_already_open`, the partial unique index is the real guarantee).
- **Join** (`joinWarRoom`): rejected on a CLOSED Incident or when no room is OPEN
  (`409 war_room_not_open`). Idempotent — a second Join by an already-active User returns their
  existing session rather than erroring or creating a duplicate (live- and test-verified:
  `activeSessionCount` stays at 1 after a repeated join, and exactly one session row exists).
- **Leave** (`leaveWarRoom`): always a safe no-op if not currently joined (or if no room is open at
  all) — a browser tab closing uncleanly can't be perfectly detected, so Leave must tolerate being
  called redundantly or too late. Live- and test-verified idempotent.
- **End** (`endWarRoom`): a conditional `UPDATE ... WHERE status = 'open'` is the real
  concurrency guard. Bulk-transitions every still-`joined` session in that room to `left` in the
  same transaction — no one stays "joined" to an ended room.

## CLOSED Incident rule

Opening is blocked outright on a CLOSED Incident. **Ending is deliberately not blocked** — see
"CLOSED Incident cleanup path" below. New joins are always rejected once the Incident is CLOSED,
independent of the room's own `status` column, so a stray open room can never accept new
participants after closure even though it isn't automatically ended.

## CLOSED Incident cleanup path (documented limitation)

The module spec's preferred behavior — closing an Incident automatically ends its open War Room in
the same operation — was evaluated and **not implemented**, because the only way to achieve it
would be modifying Module 08's already-complete, already-tested `closeIncident()` service function
to know about War Rooms. That is exactly the kind of invasive cross-module change this session's
governing rules treat as a stop condition ("unexpected modification of completed modules"), and
the module spec explicitly sanctions documenting this as a limitation instead: *"If this would
require invasive lifecycle changes: document as limitation and ensure join is denied after
Incident closes. Do not weaken CLOSED enforcement."* Module 08 was not touched. The resolution
actually implemented: `endWarRoom()` is deliberately **not** gated on Incident status, so an
authorized manager can still clean up a stray room left open after closure — live-verified: closing
an Incident with an open War Room leaves the room row `status = 'open'` (Module 08 untouched,
`GET .../war-room` still reports `"open"`), a new join attempt is correctly rejected
(`incident_closed`), and `POST .../war-room/end` still succeeds, correctly bulk-ending the
session(s) that were active at closure time.

## APIs

`GET /incidents/:id/war-room` (`war_room.read`) — current status projection.
`GET /incidents/:id/war-room/sessions` (`war_room.read`) — full session history for the current/
most recent room.
`POST /incidents/:id/war-room/open` / `/end` (`war_room.manage`, CSRF-required).
`POST /incidents/:id/war-room/join` / `/leave` (`war_room.join`, CSRF-required).

## Frontend

`WarRoomPanel.tsx`, wired into `IncidentDetailModal.tsx` as a new "War Room" tab (shown only when
the caller has `incidents.war_room.read`). Renders the status badge, the appropriate action set for
the current state and the caller's permissions, the prejoin flow, and a session-history table
(Joined/Left labels — never "Camera on"/"Muted"/"Screen sharing," since none of that state exists
yet). The "Open War Room"/"Join War Room" shortcuts are hidden (not merely disabled) once the
Incident is CLOSED.

## Incident timeline / audit

Exactly one `WAR_ROOM_OPENED` and one `WAR_ROOM_ENDED` timeline+audit event per room lifecycle —
never one event per join/leave (which would flood the timeline with low-value entries the same way
Module 13 deliberately avoids per-chat-message events). `WAR_ROOM_ENDED`'s metadata carries only a
safe `activeSessionsAtEnd` count, no participant identity. Live- and test-verified: repeated
join/leave activity produces zero additional timeline rows.

## Security

Grep-confirmed: no role-name checks, no `console.log`, no credential-like strings, no RTC/media SDK
dependency anywhere in this module's files. Every mutating route requires CSRF (mirroring every
other route in this codebase); every route requires the matching permission, enforced server-side
via the same `requirePermission()` guard used everywhere else — never a client-side-only check.

## Session concurrency

The partial unique index on `(war_room_id, user_id) WHERE status = 'joined'` is the actual
duplicate-active-session guarantee — a rapid double-join request cannot create two active rows
regardless of the service-layer pre-check's own race window, matching the same defense-in-depth
pattern used for `incident_participants` in Module 08.

## Database migration

`0013_quick_thunderball.sql`: creates `incident_war_rooms` and `war_room_sessions`, their check
constraints, and both partial unique indexes. The `war_room_sessions.incident_participant_id`
foreign key was given an explicit short name (`war_room_sessions_incident_participant_fk`) —
Drizzle's auto-generated name for it exceeds PostgreSQL's 63-byte identifier limit and would have
been silently truncated (the same issue Module 08 already hit and fixed for
`incident_participants_guest_invitation_fk`); caught and fixed before this migration was ever
applied.

## Tests

Backend: 463 total (up from 446 at the start of this module) — 17 new in
`backend/src/test/warRoom/warRoom.integration.test.ts` (not_started/open/ended lifecycle,
duplicate-open rejection, no-meeting-URL/token/provider-field-anywhere assertion, idempotent
join/leave, session persistence and history, CLOSED-Incident blocks-new-joins-but-not-end,
CLOSED-Incident blocks opening outright, the full read/manage/join permission matrix, exactly-once
timeline/audit events with no PII, and confirmation that join/leave never write per-action timeline
events). Frontend: 76 total (up from 66) — 8 new in `WarRoomPanel.test.tsx` (permission gating,
not-started/open/ended rendering, the open action, the prejoin-then-join flow, an explicit
no-camera/no-microphone/no-`<video>`-element assertion, and CLOSED hiding Join) plus 2 new in
`IncidentsPage.test.tsx` (War Room tab shown/hidden by permission).

## Live PostgreSQL validation

Confirmed `0013_quick_thunderball.sql` already applied (a re-run of `db:migrate` was a clean
no-op, with no FK-name-truncation NOTICE), and 42 permissions idempotent across two consecutive
`db:seed` runs (up from 39 — the three new permissions are `incidents.war_room.read`/`manage`/
`join`).

## Live mock/E2E validation

Full curl-driven workflow against the real backend: confirmed `not_started` before any room
existed; AUDITOR's open attempt correctly rejected (`403`); ADMIN opened the room, and a duplicate
open was correctly rejected (`409 war_room_already_open`); a RESPONDER joined, a repeated join by
the same RESPONDER left `activeSessionCount` at exactly 1 (idempotent, one DB row); AUDITOR's join
attempt was correctly rejected (`403`); resolving and closing the Incident left the room `status`
still `"open"` (Module 08 confirmed untouched) while a new join attempt was correctly rejected
(`409 incident_closed`) and `GET .../war-room` remained fully readable; `POST .../war-room/end`
still succeeded after closure, correctly bulk-transitioning the previously-`joined` session to
`left` and reporting `activeSessionCount: 0`; the Incident timeline showed exactly one
`WAR_ROOM_OPENED` and one `WAR_ROOM_ENDED` event, both PII-free.

## Live browser validation

Full workflow through the real React frontend against the real backend: opened a fresh Incident's
War Room tab and saw "Not started"; clicked "Open War Room" and saw the status flip to "Open" with
correct opener attribution; clicked "Join War Room," saw the prejoin confirmation card render with
the correct Incident number/title and display name, confirmed the join, and watched the count
update to 1, the "You are in this War Room." banner appear, the "Module 15" media placeholder
render, and the session table populate in real time — no manual reload. Clicked "Leave War Room"
and confirmed the count returned to 0 and the session row updated to "LEFT" with a timestamp, all
live. No console errors attributable to this module (only benign residual reconnect-log entries
from an already-deleted Module 13 test Incident, and the pre-login `401`s every prior module's
validation has also noted).

## Known limitations / follow-up

- Closing an Incident does not automatically end its open War Room — see "CLOSED Incident cleanup
  path" for the full rationale; `endWarRoom()` remains available post-closure specifically to allow
  cleaning up a stray open room.
- No authoritative "who's currently connected" beyond the join/leave session records already
  shown — no live presence heartbeat, since no realtime transport (WebSocket) exists for War Room
  in this module (Module 13's chat WebSocket is a separate, unrelated connection).
- Command Center (Module 12) was not extended to surface War Room status — the module spec listed
  this as optional ("may"), and it was deliberately deferred to keep this module's scope to the
  War Room foundation itself.
- No provider abstraction interface (e.g. a speculative `RtcProvider` type) was created — per the
  module spec's explicit guidance to document the planned boundary rather than write speculative
  code for an interface with no real implementation yet.
- A tab closing uncleanly (browser crash, network loss) is not detected — the session simply stays
  `joined` until an explicit Leave or the room is Ended; accurate "still actually connected"
  presence is a Module 15+ concern once a real realtime transport exists for War Room state.

## Next module

Module 15 — Audio/Video. **Not started in this session** — the operator must review this module
first (see the unattended-run's explicit Module 15 stop rule: no RTC SDK, no camera/microphone
access, no provider decision until then).
