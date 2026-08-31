# Module 21 — Dashboard & History

## Scope

A real operational Dashboard (replacing the "Signed in" placeholder that has stood in for it since
Module 00) and date-range filtering for the existing Incident/Alert history views. Both are built
entirely from existing authoritative tables — no parallel status model, no new reporting tables.

## Dashboard architecture

`GET /dashboard` (`backend/src/modules/dashboard/`) assembles one bounded aggregate response from
five existing modules' own query layers, mirroring exactly the discipline Module 12's Command
Center already established at the per-Incident level — just applied platform-wide instead of
scoped to one Incident. `dashboardService.getDashboard()` fans out with `Promise.all` to: Incident
status counts (Module 08), the 5 most-recently-updated Incidents, global Alert status counts
(Module 09), a global delivery summary (Modules 10-11), the 5 most recent Alerts (each with its own
already-computed per-Alert delivery summary, reusing `alerts/service.ts`'s `getAlert()` exactly like
Command Center's `recentAlerts` construction does), and active Contact/Group counts (Modules 04/06,
via `pageSize: 1` calls to the existing list queries — cheap, since `total` is already computed by
a separate `COUNT(*)` regardless of page size). No new query logic was written for anything Module
08-11 already computed correctly; three small global (non-Incident-scoped) query variants were
added by extracting each existing per-Incident aggregate's tally logic into a shared helper function
and calling it without the `incidentId` filter — `getIncidentStatusCounts()`,
`getGlobalAlertStatusCounts()`, `getGlobalDeliverySummary()`.

## Authoritative data sources

| Dashboard section | Source |
|---|---|
| Incident counts / recent Incidents | `incidents` (Module 08), reusing `listIncidents()`'s existing query and a new `getIncidentStatusCounts()` (same `GROUP BY status` shape as Module 12's per-Incident alert-status counts) |
| Alert counts / recent Alerts | `alerts` (Module 09), reusing `listAlerts()` and a new `getGlobalAlertStatusCounts()` |
| Delivery health | `alert_recipients` + `notification_delivery_events` (Modules 10-11), a new `getGlobalDeliverySummary()` |
| Active Contacts / Groups | `contacts`/`groups` (Modules 04/06), reusing the existing `listContacts()`/`listGroups()` query functions for their already-computed `.total` |

## Dashboard sections

Matches the stakeholder prototype's Dashboard layout (`metric-grid` of cards, an incident summary,
a "Recent Alerts" table linking to full history) adapted for BEACON's real multi-Incident model —
the prototype's single simulated "active incident" banner becomes a bounded **Recent Incidents**
table here, since the real system supports many concurrent Incidents, not one. Sections: metric
cards (Active Contacts, Active Groups, Active Incidents, Delivery Failures), a conditional
**Attention Required** card (rendered only when there's something to flag), **Recent Incidents**,
and **Recent Alerts** (clicking a row deep-links into the Alerts page and opens that Alert's detail
— reusing the exact `onNavigateToAlerts` mechanism Module 12's Command Center already built for
this same purpose, not a new navigation system).

## Metric definitions

Kept deliberately distinct, never collapsed (per the module spec's explicit warning against
conflating them): `submitted` (provider accepted it) is never treated as `delivered` (a delivery
event confirmed it); `deliveryPending` (submitted, no terminal delivery event yet) is shown as its
own number, never silently folded into either "delivered" or "failed" — a fresh dispatch with zero
delivery events yet correctly shows as 100% pending, not 0% delivered. `Delivery Failures`
(the metric card) is the sum of `submissionFailed + undelivered + bounced + failed` — every
terminal-failure state, spelled out in the Attention section's own line rather than hidden behind
one ambiguous number. No percentage/rate is displayed anywhere on the Dashboard — the module spec's
explicit fallback for ambiguous-denominator cases ("if semantics are uncertain, do not show
percentage; counts are preferable") was applied by simply not building a rate calculation at all,
since this module's time-boxed scope didn't need one.

## Attention Required

Two deterministic, explainable counts, each reusing data the Dashboard was already computing (no
extra query): `readyAlertsNotDispatched` is literally the same `ready` count from the global Alert
status breakdown; `deliveryFailures` is the same sum described above. The card renders only when at
least one is non-zero — an empty system never shows a false-positive "nothing to see here, but
here's an empty warning box."

## Incident History / Alert History

Deliberately **not** new pages. The existing `IncidentsPage`/`AlertsPage` (built in Modules 08/09
and already supporting search, status, and — for Incidents — severity filters, plus pagination and
click-through to full detail) already satisfy "browse and find historical records, including
CLOSED Incidents" — the status filter's `closed` option has worked since Module 08. Building a
second, parallel "History" page reusing the identical underlying data would have been exactly the
"second incident history system" the module spec explicitly prohibits. The one genuine gap — a
date-range filter — was added directly to both existing list endpoints
(`ListIncidentsFilter`/`ListAlertsFilter` gained `from`/`to`, validated the same way Module 20's
Audit search validates its own date range: `400` on an unparseable value or `from > to`) and both
existing pages' filter rows (two new `<input type="date">` controls each), rather than inventing a
new API surface.

## Authorization / privacy

`GET /dashboard` requires `incidents.read` — held by all five current system roles, so this
requirement doesn't practically restrict anyone relative to the Dashboard's prior no-permission-gate
placeholder; it simply makes the existing broad visibility explicit and consistent with every other
data-bearing route in this codebase, rather than leaving one route the sole exception with no
permission check at all. No new permission code was introduced. The aggregate response carries only
counts and the same safe per-Alert/per-Incident summary fields their own list endpoints already
expose — never a recipient destination, never Guest destination PII. A Guest session cookie is
never accepted (`authenticateUser()`, not `authenticateGuest()`, gates this route — same
cross-mechanism rejection Module 18 already established). Incident/Alert History's date-range
filters ride on the exact same `incidents.read`/`alerts.read` permission checks those routes
already had — filtering never bypasses authorization.

## Performance

Every count is a single `GROUP BY` or `COUNT(*)` query; the 5-item recent-Alerts fan-out is bounded
(never more than 5 additional per-Alert lookups, identical to Command Center's own bound) and runs
in parallel with everything else via `Promise.all`. No new index was added — the existing
`created_at`/`updated_at`-ordered queries and status-column lookups already had adequate coverage
from Modules 08-11's own indexing decisions, and the new global aggregates removed a `WHERE
incident_id = ...` clause rather than adding one, at the same table-scan-of-a-status-column
selectivity as their per-Incident counterparts already had.

## Frontend

`DashboardPage.tsx` replaces `App.tsx`'s static "Signed in" placeholder. `IncidentsPage.tsx`/
`AlertsPage.tsx` each gained two `<input type="date">` filter controls, wired into their existing
`refresh()`/`useCallback` dependency arrays exactly like every other filter already there — no
structural change to either page's layout or existing filter behavior.

## Tests

Backend: 574 total (up from 560) — 14 new in `dashboard.integration.test.ts` (unauthenticated/
Guest-cookie denial, authenticated access, Incident counts and bounded 5-item recent list reflecting
real creates, Alert/delivery aggregation from an actually-dispatched mock Alert with no PII leakage
and correct pending-vs-submitted distinction, active Contact counting, attention-count correctness
tied to real data, a well-formed response on an otherwise-unrelated query, Incident date-range
filter correctness plus invalid-date/`from>to` `400`s, CLOSED-Incident discoverability via the
existing status filter, and Alert date-range filter correctness plus `from>to` `400`). The
pre-existing `App.test.tsx` suite was updated: its shared `mockAuthMe` helper and every individual
test's custom fetch mock now handle `/dashboard` (previously any test landing on the default view
asserted on the literal text "Signed in", which no longer exists once a real Dashboard replaced the
placeholder) — a mechanical adaptation to the new default view, not a behavior change to what those
tests actually verify. Frontend: 110 total (up from 103) — 7 new in `DashboardPage.test.tsx` (empty
states, conditional Attention Required rendering, recent-Incident/Alert rendering, alert-row
navigation, "View all incidents" navigation, pending-vs-delivered-vs-failure distinction, error
handling).

## Live validation

Curl-driven against the running dev backend: `GET /dashboard` unauthenticated correctly returns
`401`. Full live browser validation: logged in as an ADMIN, the Dashboard rendered real metric
cards (Active Contacts/Groups, Active Incidents, Delivery Failures) computed from actual database
state, an Attention Required card correctly appeared showing "2 alerts ready but not yet
dispatched" (matching two real READY alerts left over from prior module validation), a Recent
Incidents table showed the live Incident from Module 19's own browser validation, and a Recent
Alerts table showed real dispatched/ready alerts with correct per-alert delivery counts. Clicking
"View all incidents →" correctly navigated to the Incidents page, where the new date-range filter
inputs render and are present in the DOM. Test-created leftover Alert rows and the temporary
validation admin account were cleaned up afterward.

## Known limitations / follow-up

- No delivery-rate percentage is shown anywhere, per the module spec's own "counts are preferable
  to an ambiguous KPI" fallback — a future module could add one once a precise, agreed denominator
  is defined.
- Incident/Alert History remain the existing Incidents/Alerts pages with an added date filter,
  not distinct "History" nav items — a deliberate interpretation of "reuse authoritative data, do
  not build a second history system," consistent with the stakeholder prototype's own nav (which
  has no separate "Incident History" item either — Incidents itself already covers every status,
  including closed).
- The Dashboard's Recent Incidents table is not currently clickable through to the Incident detail
  modal (unlike Recent Alerts, which does deep-link) — `IncidentsPage` has no existing "open this
  specific Incident by id" entry point to reuse the way `AlertsPage`'s `deepLink` prop already
  existed for Alerts; adding one was judged out of this module's time-boxed scope.
- No polling/auto-refresh — the Dashboard loads once per navigation, matching the module spec's
  explicit "manual refresh is sufficient, do not introduce new realtime infrastructure" guidance.

## Module 22 boundary

Administration (Module 22) is not started — no user/role/provider-configuration admin surface was
touched or introduced by this module. Security Hardening (23) and Provider Configuration (a later,
unnumbered-in-this-checklist module referenced only as "27" in this session's instructions) are
untouched. Modules 15/16 (Audio/Video, Screen Sharing) remain deferred — the Dashboard's War
Room-adjacent language was deliberately avoided (no "video active"/"participants on camera" status
anywhere), and Chat message content is never surfaced on the Dashboard, only (were it ever added)
a count — which this module didn't add, judging it non-essential to the core "what needs
attention" question the Dashboard answers.
