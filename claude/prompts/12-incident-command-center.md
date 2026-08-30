# Module 12 — Incident Command Center

## Scope

A read-only, aggregating operational view over Modules 08-11's already-authoritative data — never
a second incident/alert/participant/delivery data model. This module adds exactly one new backend
surface (`GET /incidents/:id/command-center`) and one new frontend tab. It does not implement
realtime chat, War Room, video, screen sharing, guest invitations, OTP, or a participant-presence
engine — all explicitly deferred to later modules.

## Command Center architecture

`getCommandCenter()` (`backend/src/modules/incidents/commandCenterService.ts`) assembles its
response entirely by calling existing query/service functions:

- Incident + commander + participant counts: `findIncidentById` (Module 08's own aggregate query
  — participant counts were already computed there via a `FILTER (WHERE status != 'removed')`
  count, reused verbatim).
- Alert-status totals: new `getIncidentAlertStatusCounts()` (`alerts/alertQueries.ts`) — a single
  `GROUP BY alerts.status` count scoped by `incident_id`.
- Delivery rollup: new `getIncidentDeliverySummary()` (`notifications/deliveryQueries.ts`) — the
  same aggregation shape as Module 11's per-Alert `getDeliverySummary()`, just joined to `alerts`
  and scoped by `incident_id` instead of a single `alert_id`.
- Recent Alerts: the existing `alerts/service.ts` `listAlerts()` (already supports an `incidentId`
  filter) for ordering/paging, then `getAlert()` per recent id (bounded to 5) to get each Alert's
  own already-computed `deliverySummary` — no delivery math is duplicated.
- Recent Timeline: the existing `incidents/timelineQueries.ts` `listTimeline()`, descending,
  bounded to 10.

No parallel incident/alert/participant/delivery status column, table, or cache exists anywhere in
this module — grep-confirmed no new `CREATE TABLE` in this module's migration set (there is no new
migration at all).

## Command Center route

`GET /incidents/:id/command-center` (`backend/src/modules/incidents/routes.ts`) — authenticated,
gated on the new `incidents.command_center.read` permission, `GET`-only (no mutation exists on this
surface). Returns 404 for a nonexistent Incident, 403 for a caller lacking the permission.

## Command Center response shape

```
{
  incident: IncidentDto,                 // same shape GET /incidents/:id already returns
  participantsSummary: { total, registeredUsers, contacts },
  alertsSummary: {
    total, draft, ready, dispatching, submitted, partiallySubmitted, submissionFailed, cancelled,
    delivery: { total, submissionFailed, deliveryPending, delivered, undelivered, bounced, failed }
  },
  recentAlerts: [{ id, alertNumber, title, channel, status, createdByDisplayName, createdAt,
                    updatedAt, deliverySummary }],  // bounded to 5, most-recently-updated first
  recentTimeline: [ TimelineEventDto ]    // bounded to 10, most recent first
}
```

`alertsSummary.submissionFailed` counts **Alerts** whose own status is `submission_failed`;
`alertsSummary.delivery.submissionFailed` counts individual **recipients** whose submission
failed — kept as two distinct fields (never merged into one number) since they answer different
questions, mirroring how Module 11 already keeps submission and delivery status separate.

## Alert communication summary

Live-verified: a 3-Alert Incident (1 DRAFT, 2 dispatched with one `delivered` and one `failed`
recipient) produced the exact expected `alertsSummary`: `{total: 3, draft: 1, submitted: 2,
delivery: {total: 2, delivered: 1, failed: 1, deliveryPending: 0}}`. The DRAFT Alert counts toward
`total`/`draft` but contributes nothing to the delivery rollup (it was never dispatched, so it has
no recipient rows at all).

## Recent Alerts

Bounded to 5 regardless of how many Alerts exist on the Incident (live-verified with 7 Alerts on
one Incident: `alertsSummary.total` correctly showed 7, `recentAlerts.length` stayed ≤ 5). Never
exposes recipient destination phone/email — only the same safe summary fields Module 09's
`AlertSummaryDto` already exposes, plus the Module 11 `deliverySummary` aggregate.

## Participant summary

`participantsSummary` is exactly Module 08's existing `participantCount`/`registeredUserCount`/
`contactParticipantCount` fields, relabeled — no new participant query. Guests are not represented
(none exist yet); "active/removed" participant-status detail remains the Participants tab's job,
not Command Center's.

## Commander

`incident.commander` is the same field `GET /incidents/:id` already returns. This module adds no
commander-assignment logic of its own — the Command Center tab's Overview sibling tab already
exposes the existing assign/change action; Command Center only displays the current value. Per
Module 08, commander assignment never touches `user_roles`.

## Incident actions

The Command Center tab intentionally does not duplicate Activate/Resolve/Close/Reopen or
commander-assignment controls — those remain on the pre-existing Overview tab. Command Center adds
exactly one new shortcut ("Create Alert for this Incident"), which navigates to the existing Create
Alert flow with the Incident pre-selected — it does not open a second Alert-creation
implementation.

## Quick Create Alert

`CreateAlertModal` gained an optional `initialIncidentId` prop that pre-fetches and pre-selects
that Incident (via the existing `getIncident` call) — the user still goes through the same,
unmodified creation form. The shortcut button is hidden once the Incident is CLOSED (a
live-validation-caught gap: the backend's `assertIncidentEligible` already rejects
`incidentId: <closed incident>` with `409 incident_not_eligible`, so the shortcut is hidden rather
than surfacing a guaranteed error).

## Cross-page navigation

The app has no client-side router — every page is a `view` switch in `App.tsx`, and Incident/Alert
detail are modals layered over their respective list pages. `IncidentDetailModal` accepts an
optional `onNavigateToAlerts({ alertId?, createIncidentId? })` callback, threaded
`App.tsx` → `IncidentsPage` → `IncidentDetailModal`. `App.tsx` implements it by switching `view` to
`"alerts"` and passing a one-shot `deepLink` prop into `AlertsPage`, which opens the matching Alert
detail modal (or the Create Alert modal, pre-selected) on mount and reports back via
`onDeepLinkHandled` so the deep-link doesn't re-fire on a later re-render. Live-verified: clicking
"View" on a recent Alert card switched to the Alerts page and opened that exact Alert's detail
modal directly.

## Permission mapping

New code: `incidents.command_center.read`.

| Role | Grants |
|---|---|
| ADMIN | yes |
| INCIDENT_COMMANDER | yes |
| COMMUNICATION_MANAGER | yes |
| AUDITOR | yes (consistent with its existing compliance/read-only access to Incidents and Alerts) |
| RESPONDER | yes |

**Authorization model is global**, matching every other Incident permission in this codebase (there
is no "assigned to this Incident" row-level concept anywhere in Modules 08-11) — the module spec's
explicit fallback ("if row-level security is ambiguous, retain the current global permission
model") was applied rather than inventing new row-level authorization. Documented here as a known
limitation, not a gap introduced by this module.

## Frontend

`IncidentDetailModal.tsx` gained a "Command Center" tab (shown only when the caller has
`incidents.command_center.read`), rendering: a Communication Status card (alert totals + delivery
rollup + the Create Alert shortcut), a Recent Alerts table (with per-alert delivery text and a
"View" button), and a Recent Timeline table. No chat window, video tiles, screen-share UI, or War
Room participant state — those are explicitly Modules 13/14+.

## Performance

Bounded queries throughout: `getIncidentAlertStatusCounts`/`getIncidentDeliverySummary` are each a
single grouped aggregate query; `recentAlerts` fans out to at most 5 `getAlert()` calls (a small,
fixed bound, not proportional to the Incident's total Alert count); `recentTimeline` is a single
paged query capped at 10 rows. No N+1 pattern scales with an unbounded row count. No new indexes
were needed — the queries reuse existing `alerts.incident_id`/`alert_recipients.alert_id` foreign
keys, which are already indexed from Modules 09-11.

## Security

Grep-confirmed: no role-name checks, no `console.log`, no credential-like strings anywhere in the
new command-center files. The route is `authenticate` + `requirePermission`-gated like every other
route in this codebase; being `GET`-only, it needs no CSRF check (mutations remain on their
existing, unmodified endpoints). Live- and test-verified the response never contains recipient
destination phone/email or Contact names, even when the Incident has dispatched Alerts with
delivery events.

## Live validation

Full curl-driven workflow against the real backend: created and activated an Incident, assigned a
commander, added one User and one Contact participant, created 3 Alerts (2 dispatched with mixed
`delivered`/`failed` outcomes, 1 left DRAFT) — the Command Center response matched every expected
count exactly (participants, commander, alert totals, delivery rollup, per-alert delivery
summaries, timeline ordering). Confirmed the response stays `200` and fully populated after
resolving and closing the Incident, and that the pre-existing CLOSED-Incident mutation guard
(`PATCH /incidents/:id` → `409 incident_closed`) is unaffected by this module. Confirmed a 7-Alert
Incident still bounds `recentAlerts` to 5 while `alertsSummary.total` stays exact. Confirmed live
that the response never contains any created Contact's phone number or name.

## Live browser validation

Full workflow through the real React frontend: opened the Command Center tab on a CLOSED Incident
and confirmed every figure matched the curl-verified data exactly, confirmed the "Create Alert for
this Incident" shortcut was correctly absent (CLOSED), and clicked "View" on a recent Alert card —
confirmed the app switched to the Alerts page and opened that exact Alert's detail modal directly,
showing its real `FAILED` delivery status. No console errors beyond the pre-existing benign Vite
HMR websocket noise and expected pre-login 401s.

## Test count / results

Backend: 428 total (up from 413 at the start of this module) — 15 new in
`backend/src/test/incidents/commandCenter.integration.test.ts` (auth/authz, safe aggregate shape,
PII-freedom, exact participant/alert/delivery counts, commander, lifecycle reflection, bounded
recent-alerts, CLOSED-read-works, CLOSED-mutation-still-blocked). Frontend: 55 total (up from 51) —
5 new in `IncidentsPage.test.tsx` (summary rendering, View navigation, Create-Alert-shortcut
navigation, CLOSED-hides-shortcut, tab hidden without permission).

## Lint / typecheck / build

All three workspaces (frontend, backend, database): lint clean, typecheck clean, build clean.

## Known limitations / follow-up

- Command Center authorization is global, not row-level (see "Permission mapping") — matches the
  rest of this codebase's current Incident authorization model; a future module could introduce
  "assigned responder" row-level scoping if the product requires it.
- No live "who's currently viewing/online" indicator — that's Module 13/14+'s presence job, and
  this module deliberately does not simulate it.
- No WebSocket/polling auto-refresh — the tab re-fetches on open and after a mutating action taken
  from within it; a viewer must reopen the tab (or the Incident modal) to see another actor's
  changes.

## Next module

Module 13 — Realtime Incident Chat.
