# Module 13 — Realtime Incident Chat

## Scope

Persistent, incident-scoped realtime text chat for registered, authenticated BEACON Users only.
PostgreSQL is the durable record; WebSocket is transport, never the source of truth. Not War Room,
not audio/video, not screen share, not Guest chat, not general enterprise messaging. Guests
(Modules 17-18) are an explicit, documented future boundary — `chat_messages.author_type` remains
schema-compatible with `'guest'`, but this module only ever writes `'user'`.

## Architecture

WebSocket (`@fastify/websocket`) + Fastify + PostgreSQL. Every message is persisted inside
`sendMessage()` (`backend/src/modules/chat/chatService.ts`) *before* being broadcast — the
WebSocket layer never holds message state itself beyond a process-local connection registry (who
is currently listening for which Incident). A page refresh, browser reconnect, or backend restart
all recover cleanly because the client always re-fetches history from the REST endpoint on
(re)connect rather than depending on any in-memory replay.

## Reused schema, not duplicated

`chat_messages` already existed as a Module 01 foundation table (`incident_id`, `author_type`,
`user_id`, `participant_id`, `message_text`, `created_at`, with check constraints already enforcing
`author_type ∈ {user, guest}` and the matching foreign-key-per-type rule). This module adds exactly
one column — `seq` (`serial`, unique-indexed), mirroring `incident_timeline_events.seq` — and wires
up the first real read/write path. No second chat table was created.

## Incident scoping

Every message and every WebSocket connection is scoped to exactly one `incidentId`, taken from the
URL path (`/ws/incidents/:id/chat`, `/incidents/:id/chat/messages`) — never a client-supplied field
inside a message payload. A client cannot subscribe to an incident it isn't authorized to read (see
"WebSocket authorization" below); there is no global/cross-incident chat room.

## Authorship

Registered Users only (`author_type = 'user'`, `user_id` set from the authenticated session — never
client-supplied). Contacts and Guests cannot author messages in this module.

## Message limits

4000 characters max (`MAX_MESSAGE_LENGTH` in `chatService.ts`); empty or whitespace-only bodies are
rejected. Enforced server-side in `sendMessage()` — the single, shared persistence path — so no
send route can bypass it.

## Text only, XSS safety

Plain text only — no attachments, images, links-with-preview, reactions, or Markdown/HTML
rendering. The frontend (`ChatPanel.tsx`) renders `messageText` only as a React text child, never
via `dangerouslySetInnerHTML`; live- and test-verified that an XSS-shaped body
(`<img src=x onerror=alert(1)>`) is stored and rendered back as inert literal text — `innerHTML`
of the rendered node is the HTML-escaped string, and no such `<img>` element ever exists in the DOM.

## Permissions

New codes: `incidents.chat.read`, `incidents.chat.send` — deliberately separate, so AUDITOR can
review chat history for compliance without being able to participate.

| Role | read | send |
|---|---|---|
| ADMIN | yes | yes |
| INCIDENT_COMMANDER | yes | yes |
| COMMUNICATION_MANAGER | yes | yes |
| RESPONDER | yes | yes |
| AUDITOR | yes | no |

Enforced via the existing `requirePermission()` guard, reused unchanged as a WebSocket route
`preHandler` (see "WebSocket authentication").

## CLOSED Incident behavior

Read access and full history remain available on a CLOSED Incident (a live-verified WebSocket
connection stays `CONNECTED` and can still fetch history after close). New sends are rejected —
`sendMessage()` throws `409 incident_closed` before ever calling `insertMessage()` — enforced
server-side, independent of the frontend's own disabled-compose-input UI. Live- and test-verified:
a message attempted on a CLOSED Incident is neither persisted nor broadcast to any connected
client.

## WebSocket authentication

`GET /ws/incidents/:id/chat` reuses the exact same `createAuthenticateHook(config)` preHandler
every REST route already uses — no separate WebSocket-specific auth code exists. `@fastify/websocket`
runs normal Fastify `preHandler`s *before* completing the WebSocket upgrade, so an unauthenticated
request never gets upgraded at all; it's rejected at the HTTP level (`401`), verified live via a
`ws` client observing an `unexpected-response` event rather than `open`. The session cookie is
`HttpOnly` and attaches to the WebSocket handshake automatically via normal same-site cookie
rules — no token is ever placed in a URL or query string.

## WebSocket authorization

`incidents.chat.read` is enforced the same way, as a second preHandler (`requirePermission(...)`)
— a caller without it never completes the upgrade (`403`, live- and test-verified). After upgrade,
the connection handler independently verifies the Incident actually exists (closing with a safe
`4404` code otherwise) — the permission check alone doesn't guarantee that. Every individual "send"
command is *additionally* re-checked against `incidents.chat.send` inside the message handler
(`hasPermission()`), since a caller may hold an open, read-authorized connection without ever
having send rights (AUDITOR) — live- and test-verified that an AUDITOR's send attempt is rejected
with `not_authorized` and persists nothing.

## WebSocket CSRF / Origin

WebSocket handshakes aren't covered by normal CORS enforcement, and a hostile page can open a
cross-origin WebSocket with the victim's cookies attached regardless of CORS — Origin header
validation is what actually prevents this (the WebSocket-appropriate analogue of CSRF protection).
`verifyOrigin()` (`backend/src/modules/chat/routes.ts`) checks `request.headers.origin` against the
single configured `CORS_ORIGIN` value (reusing the app's existing CORS config, not a new setting) —
never a wildcard. Live- and test-verified: a connection attempt from an unexpected Origin is
rejected (`403`) before authentication is even evaluated.

## Message send path

Client → authenticated, Origin-validated, permission-checked WebSocket `{type: "send", body,
requestId}` command → server validates (length, permission, Incident not CLOSED) → `sendMessage()`
persists to PostgreSQL → **only after** persistence succeeds does the server acknowledge the sender
and broadcast to other connections. An uncommitted message is never broadcast — live- and
test-verified that a failed send (CLOSED Incident, over-length, empty, rate-limited, unauthorized)
produces zero rows in `chat_messages` and zero broadcast to any other connected client.

## Broadcast model

The server sends the sender a `{type: "sent", requestId, message}` acknowledgement carrying the
full persisted message, and broadcasts `{type: "message", message}` to every **other** connection
on that Incident — the sender is deliberately excluded from its own broadcast. This was a
correctness fix made during this module's own testing: an earlier version broadcast to everyone
*including* the sender, which double-delivered the same message down the sender's own connection
(once as the ack, once as the broadcast) and, worse, desynchronized a naive one-response-per-send
client loop into misreading which response belonged to which send — a bug caught by an automated
rate-limit test before it ever reached a live session. The frontend renders a message from *either*
the "sent" ack (its own messages) or a "message" broadcast (everyone else's) — exactly one render
path per message, never both.

## Message IDs and ordering

`id` (UUID) and `seq` (a `serial` tiebreaker column, mirroring `incident_timeline_events.seq`) are
both server-generated on insert — never accepted from the client. Ordering is by `seq` exclusively:
a stable, monotonic integer, safe even when two messages share the same `created_at` timestamp (a
real possibility under concurrent senders, since Postgres `timestamp` precision alone is not a safe
tiebreaker). The client's `requestId` is a correlation id only, chosen by the client
(`crypto.randomUUID()`) purely to match an ack/error back to the compose action that triggered
it — it is never treated as message identity.

## Message history / pagination

`GET /incidents/:id/chat/messages?before=<seq>&limit=<n>` — cursor-based on `seq`
(`backend/src/modules/chat/chatQueries.ts` `listMessages`), returned oldest-first for direct
rendering. Internally fetches `limit + 1` rows newest-first, reverses, and uses the extra row purely
to compute `hasMore` without an unbounded second query. Default page size 50, max 100. Live- and
test-verified: paging with a `before` cursor returns exactly the expected prior page with correct
`hasMore` semantics.

## Reconnect

The frontend's `useChatSocket` hook (`frontend/src/chat/useChatSocket.ts`) reconnects on an
unexpected close with capped exponential backoff (1s → 15s max), and on **every** (re)connect —
including the very first connect — always re-fetches history from the REST endpoint first, then
opens the socket. It never assumes the WebSocket itself can replay anything missed while
disconnected; PostgreSQL via the REST endpoint is the only source of truth for catching up. A
deliberate frontend-close (component unmount) does not trigger a reconnect attempt.

## Multiple clients / same user

Multiple simultaneous connections (different tabs, different users, or the same user in two tabs)
are all tracked independently in the process-local connection registry and each receives
broadcasts intended for its Incident. Live-verified: two independent connections authenticated as
the *same* admin user (a real browser tab plus a separate script-driven WebSocket client) both
correctly received each other's broadcast messages in real time.

## Presence

Deliberately minimal, per the module's explicit boundary: the frontend shows only its own
connection state (`Connecting…` / `Connected` / `Reconnecting…` / `Disconnected`) — never an
authoritative "who else is online" list. That is out of scope until a later module.

## Message audit / logging

Individual chat messages are **not** written to the global `audit_logs` table — `chat_messages`
itself is the durable communication record, and duplicating every message into audit would
overwhelm it for no compliance benefit (`incidents.chat.read`/AUDITOR access already covers review
needs). No new audit event types were added for Module 13. Server-side logging (Fastify's default
request logger, unchanged) never includes message body, and grep-confirmed no `console.log` /
message-content logging anywhere in `backend/src/modules/chat/`.

## Incident timeline

No timeline event is written per chat message (would overwhelm the operational timeline with a
per-message entry) — consistent with the module's explicit instruction not to do this.

## Rate limiting

Per-connection, in-memory sliding window: at most 15 sends per rolling 10-second window
(`RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX_SENDS` in `chatWebsocket.ts`). Exceeding it returns a
`{type: "error", error: "rate_limited"}` response and drops that one message — the connection
itself is never closed, since a burst shouldn't lock a responder out of the incident entirely.
Live-verified via an 18-send burst test that some sends are rejected while the connection stays
open.

## Payload validation

Strict schema check (`isIncomingSendFrame`) — rejects malformed JSON, an unrecognized `type`,
missing/wrong-typed `body`, and any unexpected extra key, each with a distinct safe error response.
The `@fastify/websocket` plugin is registered with a 16KB `maxPayload` cap, bounding raw frame size
independent of the 4000-character application-level message limit.

## Backpressure

A lightweight guard, not a full queue: `broadcast()` skips any client whose `bufferedAmount`
already exceeds 1MB rather than piling more data onto an already-slow/stalled connection. Dead
sockets are removed from the registry on their `close` event. No distributed/durable message queue
was built — deliberately, per the module's "do not over-engineer" guidance.

## Single-process scaling limitation

The connection registry (`connectionsByIncident`, a plain in-memory `Map`) is process-local —
BEACON currently runs as a single-process modular monolith, so this is sufficient. A future
multi-instance deployment would need a pub/sub layer (e.g. Redis) to fan a broadcast out across
processes; this is a documented, deliberate limitation, not solved in this module.

## Frontend

`frontend/src/chat/`: `useChatSocket.ts` (connection lifecycle, reconnect, history-on-connect,
send/ack correlation via `requestId`) and `ChatPanel.tsx` (message list with sender/timestamp,
"Load older messages", compose input disabled when the Incident is CLOSED or the caller lacks
`incidents.chat.send`, a connection-state badge). Wired into `IncidentDetailModal.tsx` as a new
"Chat" tab, shown only when the caller has `incidents.chat.read`.

## Database migration

`0012_cuddly_juggernaut.sql`: adds `chat_messages.seq` (`serial`, `NOT NULL`), a unique index on
it, and rebuilds the existing `(incident_id, created_at)` index as `(incident_id, created_at, seq)`.

## Tests

Backend: 446 total (up from 428 at the start of this module) — 18 new in
`backend/src/test/chat/chatWebsocket.test.ts`, run against a real listening HTTP server (a
WebSocket upgrade cannot be exercised through Fastify's `inject()`): authentication/authorization
(no cookie, wrong Origin, no `incidents.chat.read`, nonexistent Incident, successful AUDITOR
read-only connect), send authorization (AUDITOR rejected and persists nothing; ADMIN allowed and
persists), broadcast correctness (a second connection receives a broadcast; a CLOSED-Incident send
neither persists nor broadcasts), payload validation (empty/whitespace, over-length, unknown
command, malformed JSON, XSS-shaped body stored verbatim), rate limiting (a burst produces some
rejections without closing the connection), and REST history (cursor pagination, permission gating,
CLOSED-Incident history remains readable). Frontend: 66 total (up from 56) — 8 new in
`ChatPanel.test.tsx` (permission gating, history load, XSS-inert rendering, send/ack flow including
the sender-echo regression, CLOSED/no-send-permission disabling, per-request error surfacing) plus
2 new in `IncidentsPage.test.tsx` (Chat tab shown/hidden by permission).

## Live PostgreSQL validation

Confirmed `0012_cuddly_juggernaut.sql` already applied (a re-run of `db:migrate` was a clean
no-op), and 39 permissions idempotent across two consecutive `db:seed` runs (up from 37 — the two
new permissions are `incidents.chat.read`/`incidents.chat.send`).

## Live mock/E2E validation, two clients, real dev server

Ran end-to-end against the real backend and real frontend (not `.inject()`/mocks): logged into the
browser as an ADMIN user, opened an Incident's Chat tab, and confirmed a live WebSocket connection
(`CONNECTED` badge) against the real server. A second, independent `ws`-based script client
authenticated as **AUDITOR** attempted to send a message — correctly rejected `not_authorized`,
confirming read-only enforcement live. A third independent client, authenticated as the *same*
ADMIN user, sent "Hello from second-admin-client" — the real browser tab displayed it via live
broadcast **with no page refresh**, proving genuine multi-connection fan-out through the actual
dev server (not just the automated test harness). A full page reload correctly restored complete
history from the REST endpoint (never relying on WebSocket replay). Resolving and closing the
Incident via the real API, then reloading, showed the CLOSED banner, kept the connection
`CONNECTED` with full history visible, and correctly disabled the compose input
(`placeholder="Chat is unavailable right now"`).

## Bugs found and fixed during live/automated testing

- **Broadcast double-delivery**: the sender was originally included in its own message broadcast,
  causing every successful send to deliver the same message twice down the sender's connection
  (once as the "sent" ack, once as the "message" broadcast). Caught by an automated rate-limit test
  behaving unexpectedly (a naive 1-response-per-send test loop desynchronized against the extra
  message). Fixed by excluding the sender's own socket from `broadcast()`.
- **Sender-echo gap**: after fixing the above by excluding the sender from broadcast, the frontend
  no longer had any code path that rendered the sender's own message (previously it only listened
  for the "message" broadcast event) — a real user's own sent message would never appear in their
  own chat. Caught live in the browser, not by the backend test suite (which never asserted on
  frontend rendering). Fixed by having the frontend also render the message carried in the "sent"
  ack.

## Known limitations / follow-up

- Single-process broadcast only (see "Single-process scaling limitation") — a future
  multi-instance deployment needs a pub/sub layer.
- No message editing or deletion — messages are immutable for this MVP, per the module's explicit
  instruction.
- No authoritative multi-user presence — only local connection state is shown.
- Guest chat authorship remains entirely unimplemented, deferred to Modules 17-18.
- Backend restart recovery was validated by design (history is always durable in PostgreSQL and
  always re-fetched on reconnect) and by the reconnect-with-backoff logic itself, rather than by
  physically killing and restarting the live dev server process during this session.

## Next module

Module 14 — War Room Foundation.
