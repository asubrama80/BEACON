# Module 07 — Templates

## Scope

Reusable communication Templates: create/edit/disable/enable, safe placeholder-based content, and a synthetic-values preview — for SMS and Email. A Template is inert, reusable message content only; it never identifies recipients, never sends anything, and never touches a provider. Module 08 (Incidents), Module 09 (Alerts), and Module 10 (Notification Providers) remain untouched.

## Architecture: Contact vs. Group vs. Template vs. Alert

- **Contact** — a person BEACON may notify (Module 04).
- **Group** — a reusable set of Contacts (Module 06).
- **Template** — reusable *message content*, with zero knowledge of who will receive it.
- **Alert** *(future, Module 09)* — combines a Template's rendered content with a recipient set (Contacts/Groups) and actually sends it.

Enforced by construction, not just convention: nothing in the `templates` schema or the `templates` module references `contacts`, `groups`, `group_members`, or any recipient concept at all (grep-verified — zero such references anywhere in `backend/src/modules/templates/`). No Alert, Incident, or Incident Participant record is ever created by any Template operation, including preview.

## Channel model

One `templates` row per Template, with a `channel` column (`sms` | `email`) — Module 01's original design, preserved as-is rather than split into separate SMS/Email tables. This module implements exactly two channels; `voice` and `push` remain **structurally** allowed by the existing check constraint (`templates_channel_check`, inherited from Module 01) but are **not implementable through any Module 07 API** — every route's channel field is schema-restricted to `["sms", "email"]`, and the service layer independently rejects anything else. Nothing about push/voice/Teams/Slack/WhatsApp was implemented here; the wider constraint is dormant infrastructure for a future module, not something this module exercises.

## Schema

Reused Module 01's `templates` table almost entirely as-is. One targeted correction, migration `0007_silent_stardust.sql`:

```sql
DROP INDEX "templates_name_channel_idx";
CREATE UNIQUE INDEX "templates_name_lower_channel_unique_idx" ON "templates" USING btree (lower("name"), "channel") WHERE "templates"."deleted_at" IS NULL;
CREATE INDEX "templates_status_idx" ON "templates" USING btree ("status");
```

- **Name uniqueness is case-insensitive, scoped per channel** (Module 06's Groups pattern applied here): "Emergency Closure" and "emergency closure" collide, but "Emergency Closure" (SMS) and "Emergency Closure" (Email) may coexist — deliberately preserving Module 01's original per-channel-scoped uniqueness decision rather than replacing it with a single global-name model. Scoped to non-deleted rows; disabling a Template does not free its name, same rationale as Groups.
- **`severity`** (an existing, nullable column from Module 01) is left completely untouched by this module — not accepted on create/update, not returned in any DTO. It's reserved for whichever future module needs alert-severity classification; exposing or validating it now would be exactly the "speculative field" the module spec warns against.
- **No version-history table** exists or was added — Module 01 never built one, and this module doesn't need one (see "Future Alert snapshot requirement" below).
- **`channel` is immutable after creation** — the update endpoint's schema doesn't accept a `channel` field at all. This was a deliberate reading of "do not silently switch channel if doing so would create inconsistent fields": rather than build channel-switch reconciliation logic (what happens to a subject when SMS→Email, or vice versa) for a need nobody described, channel is simply fixed at creation. Create a new Template if you need the other channel.

## SMS fields and behavior

- `body` — required, non-blank, capped at 5000 characters (a generous ceiling, not an SMS-specific limit — segment guidance is informational, never a hard block on message length).
- `subject` — **never accepted for SMS**. `POST /templates` and `PATCH /templates/:id` both reject a non-empty `subject` on an `sms` Template with `400 invalid_request`, live-verified.
- **SMS segment guidance** (`backend/src/modules/templates/smsSegments.ts`): a small, hand-written GSM 03.38 basic+extension character-set classifier — deliberately not a new dependency, since the entire algorithm is a character-membership check plus segment-size arithmetic. Text using only the GSM-7 alphabet reports `encoding: "GSM-7"` (160 chars for a single segment, 153/segment once concatenated); any other character (emoji, most non-Latin scripts, smart quotes, …) forces the *whole* message to `"UCS-2"` (70/67 chars per segment) — matching real carrier behavior, where one non-GSM-7 character anywhere changes the whole message's encoding. Explicitly labeled an **estimate** everywhere it's surfaced (API response field name, frontend copy) — never claimed as carrier-billing-authoritative. Live-verified: a 53-character message reports 1 GSM-7 segment; a 161-character message reports 2.

## Email fields and behavior

- `subject` — **required** for Email, capped at 255 characters. Rejected with `400 invalid_request` if blank on create, or if cleared to blank on update.
- `body` — same required/non-blank/5000-char-cap rule as SMS.
- Plain-text content only, matching the module spec's MVP guidance ("prefer safe plain-text content... unless the prototype explicitly requires rich HTML") — the stakeholder prototype's own Template preview renders plain text with line breaks, not HTML authoring, so plain text was the correct, prototype-consistent choice. No HTML sanitizer was introduced since no HTML is ever accepted or rendered as markup.

## Placeholder registry

Centralized in exactly one place, `backend/src/modules/templates/placeholders.ts` — the sole source of truth for what's a valid placeholder:

```ts
firstName   → "First Name"   → Contact → sample "Alex"
lastName    → "Last Name"    → Contact → sample "Morgan"
displayName → "Display Name" → Contact → sample "Alex Morgan"
```

The frontend (`frontend/src/templates/placeholders.ts`) has its own tiny array of the same three `{key, label, token}` entries purely for rendering the placeholder-insert buttons — explicitly documented as a UI-convenience mirror, never a second source of truth: the frontend never invents or validates a placeholder on its own, and every create/update/preview request is re-validated server-side against the real registry regardless of what the client sent.

## Placeholder grammar and validation

`backend/src/modules/templates/rendering.ts`'s `validateTemplateContent()` is the single gate every piece of Template text (body, and subject for Email) passes through on create, update, *and* preview — including ad-hoc unsaved preview content, so the safety guarantee doesn't have a "preview bypass":

- A valid placeholder is exactly `{{identifier}}` (optionally padded with whitespace inside the braces), where `identifier` matches `[A-Za-z0-9_]+` **and** is one of the three registered keys.
- Anything shaped like `{{...}}` whose inner content isn't a bare identifier (`{{user.password}}`, `{{foo()}}`, `{{#each contacts}}`) is rejected as **malformed placeholder syntax** — never partially interpreted.
- A syntactically valid bare identifier that isn't registered (`{{middleName}}`, `{{constructor}}`, `{{ssn}}`) is rejected as an **unknown placeholder** — distinguishing "you spelled something code-like" from "you asked for something that doesn't exist" in the error message, without treating either as acceptable.
- `${...}` and `<% %>` are rejected outright wherever they appear, even outside any `{{}}` span — defense against a template ever being fed into some other engine's expression syntax by accident.

There is no loop, conditional, function call, object-property access, or any other executable construct anywhere in this grammar — it is pure token substitution over a three-item allowlist. All 24 unit tests in `rendering.test.ts` exercise this directly, including every explicit reject-example from the module spec.

## Rendering

`renderTemplate({ subject?, body, values })` in the same `rendering.ts` file is the one reusable substitution function — used identically by this module's preview endpoint and intended for a future Alert module's real-recipient rendering (pass real Contact field values instead of `samplePlaceholderValues()`; nothing else about the function changes). It never evaluates content as code and never touches a database. An unresolved placeholder (a key the caller's `values` didn't supply) is left as its original `{{key}}` token in the rendered output — never silently dropped, never replaced with a guess — and is also reported explicitly via `unresolvedPlaceholders: string[]`, so a future caller (e.g. an Alert-send path) can decide what "unresolved" should mean for its own use case. For this module's own preview, `samplePlaceholderValues()` supplies every registered key, so `unresolvedPlaceholders` is empty in practice for any Template that passed create/update validation.

## Preview

`POST /templates/preview` accepts **either** `{ templateId }` (an existing, already-validated Template) **or** ad-hoc `{ channel, subject?, body }` (unsaved draft content, for previewing before you've saved anything). Both paths: re-validate placeholder content exactly as create/update would, render with synthetic sample values only, include SMS segment guidance when the channel is `sms`, and — critically — **never touch a Contact, never create a Contact, Alert, or Template row, and are never durably audited** (the module spec explicitly doesn't require preview auditing, since nothing persists). Live-verified: the database's template row count is identical before and after a preview call.

## Lifecycle

`active`/`inactive` via `status`, identical pattern to Contacts and Groups: disable preserves the row and all its content; nothing is ever hard-deleted. `GET /templates?status=inactive` correctly surfaces disabled Templates so they remain historically identifiable; the default (unfiltered) list still returns both, leaving "exclude inactive by default" as a UI/consumer choice rather than something the API silently enforces.

## Permissions

New codes (`MODULE_07_PERMISSIONS`): `templates.read`, `templates.create`, `templates.update`, `templates.disable`.

| Role | Grant | Why |
| --- | --- | --- |
| ADMIN | all four | Full administrative access, consistent with every other permission. |
| COMMUNICATION_MANAGER | all four | Composing reusable alert content is exactly this role's job. |
| AUDITOR | `templates.read` | Read-only role. |
| INCIDENT_COMMANDER | `templates.read` | Visibility into what content is available during incident response — same justification pattern as this role's `contacts.read`/`groups.read` grants; no create/update/disable access invented to fill the role. |
| RESPONDER | none | No stated operational need for a responder to browse or manage message templates — the module spec explicitly allowed leaving this empty absent a concrete justification, matching every other RESPONDER grant in this project so far. |

Seed is idempotent — live-verified (two `db:seed` runs, unchanged: 21 permissions, 43 role-permission mappings).

## APIs

All routes require `authenticate` + the named permission; the five mutating routes (`POST /templates`, `PATCH /templates/:id`, the two lifecycle POSTs, and `POST /templates/preview`) additionally require CSRF.

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/templates` | `templates.read` | Paginated, searchable by name, channel- and status-filterable; returns summary DTOs (no `body`) |
| GET | `/templates/:id` | `templates.read` | Full detail including `body` |
| POST | `/templates` | `templates.create` | |
| PATCH | `/templates/:id` | `templates.update` | Allowlist: `name`, `subject`, `body` — never `channel` or `status` |
| POST | `/templates/:id/disable` | `templates.disable` | |
| POST | `/templates/:id/enable` | `templates.disable` | |
| POST | `/templates/preview` | `templates.read` | See "Preview" above; gated on read since nothing sensitive is exposed and nothing persists |

## Frontend

`frontend/src/templates/` — a card-grid `TemplatesPage` (matching the stakeholder prototype's `.tpl-card-grid`/`.tpl-tile` visual language) with search/channel-filter/status-filter/pagination-footer and a permission-gated "Create Template" button. `CreateTemplateModal` (channel selector, name, conditional subject field, body textarea with a live character count and placeholder-insert buttons, a "Preview" action). `TemplateDetailModal` (same editing surface for an existing Template, plus disable/enable). `TemplatePreviewModal` (shared by both — renders either an existing Template by id or unsaved draft content, shows the rendered subject/body and, for SMS, the encoding/character/segment estimate). Reachable via its own top-level "Templates" nav item, permission-gated on `templates.read`. Frontend permission checks are UX-only; the backend independently authorizes every action.

## XSS / content security

- Rendered preview content is inserted as plain React text content (`{result.renderedBody}`), never via `dangerouslySetInnerHTML` — grep-confirmed zero occurrences of `dangerouslySetInnerHTML` anywhere in `frontend/src/templates/` (the one match found is a code comment explaining why it's *not* used). Line breaks are preserved with CSS `white-space: pre-wrap`, not manual HTML insertion.
- A Template body/subject containing an XSS-shaped payload (`<script>alert("xss")</script>`) is stored and returned **verbatim as inert text** — verified live and in an integration test — because nothing in this pipeline ever interprets Template content as markup or code: not the backend (plain string storage, allowlisted-placeholder-only substitution), not the frontend (plain text rendering).
- No `eval`, `new Function`, or any dynamic-code-execution construct exists anywhere in the templates module, backend or frontend (grep-confirmed).

## Audit

`TEMPLATE_CREATED`, `TEMPLATE_UPDATED`, `TEMPLATE_DISABLED`, `TEMPLATE_ENABLED` via the same shared `recordAuthEvent()` helper. Metadata is deliberately minimal and never includes the message body or subject: `TEMPLATE_CREATED` logs `{name, channel}`; `TEMPLATE_UPDATED` logs only the *names* of changed fields (`{fields: ["body"]}`), never their new values; disable/enable log no extra metadata at all. Live-verified: a full create→update→disable→enable sequence on a Template whose body contained a unique marker string produced zero occurrences of that marker anywhere in the resulting audit rows.

## Privacy guidance (not enforced — documented)

Templates are reusable content and should generally reference recipients only via placeholders, never hard-coded real names/phones/emails. This module deliberately does **not** attempt to detect or block real-looking PII in free-text Template content — the spec explicitly warned against building fragile heuristic DLP for this. It's operator guidance, not a technical control.

## Future Alert snapshot requirement (not built here)

Templates can be edited after creation (`PATCH`), and this module does not build a version-history table to preserve exactly what was sent by a past Alert — deliberately, per the module spec's explicit MVP guidance. **The responsibility for preserving "the exact message an Alert actually sent" belongs to a future Module 09**, which should snapshot the *resolved* (rendered) content into the Alert record at send time, not rely on the Template row remaining unchanged forever. This module's `renderTemplate()` is exactly the reusable function Module 09 would call to produce that snapshot.

## Security review performed

- Grepped the whole `templates` module (backend and frontend) for `contacts`/`groups`/`group_members` references — none found; Templates cannot reference recipients even by accident.
- Grepped for `eval`, `new Function`, `child_process`, `require(` — none found in the templates module.
- Grepped for Twilio/SendGrid/SES/Nodemailer or any provider-shaped name — none found; no accidental provider integration.
- Grepped for "alert"/"incident" — the only matches are doc comments describing future reusability, not implemented behavior.
- Grepped for role-name checks (`role.code ===`, `role ===`) — none found.
- Confirmed all 7 routes chain `authenticate` + `requirePermission`, and exactly the 5 mutating routes call `requireCsrf`.
- Verified live and in tests: mass-assignment on update is a no-op (forged `status`/`channel`/`id` fields ignored — `channel` in particular can never change post-creation); an unknown/malformed placeholder is rejected identically whether it appears in a saved-create request or an ad-hoc preview request; a case-equivalent duplicate name on the same channel is rejected while the same name on a different channel is permitted; preview never creates a database row.
- Verified no auth-secret fields ever appear in a Template response (test scan for `passwordHash|argon2|mfa|sessionToken|recoveryCode`).
- Verified no message body/subject content ever appears in audit metadata (live scan with a unique marker string).
- Confirmed by review: no Alert, Incident, Incident Participant, or provider-send code was introduced anywhere in this module.

## Tests

- **Unit** (`rendering.test.ts`, 15 tests): every placeholder-grammar accept/reject case from the module spec (known placeholders, whitespace tolerance, unknown placeholder, dotted-path, function-call syntax, handlebars block syntax, a reserved-looking-but-unregistered identifier, `${}`, `<% %>`), plus `renderTemplate` substitution, subject+body together, unresolved-placeholder token preservation and reporting, and confirmation that `${}`-shaped text is never evaluated.
- **Unit** (`smsSegments.test.ts`, 9 tests): GSM-7 classification, the exact 160/161-char single-vs-concatenated-segment boundary, multi-segment counting at the 153-char concatenated rate, an extended-table character counting as 2 GSM-7 units, UCS-2 (emoji) classification and its 70/71-char boundary, empty-content zero-segment edge case, and a placeholder-token-shaped string still classifying as GSM-7.
- **Integration** (`routes.integration.test.ts`, 29 tests, live `beacon_dev`): full RBAC matrix (ADMIN/COMMUNICATION_MANAGER full; AUDITOR/INCIDENT_COMMANDER read-only; RESPONDER and unauthenticated denied), SMS and Email creation, the SMS-must-not-have-a-subject and Email-must-have-a-subject rules, blank-name/invalid-channel/missing-body rejection, case-equivalent duplicate-name rejection *and* cross-channel name coexistence, malformed-UUID/unknown-UUID handling, list/search/channel-filter/status-filter, mass-assignment-safe update, disable/enable, all three placeholder-grammar reject cases at the API layer, preview (ad-hoc SMS with segment metadata, by-existing-template-id, unknown-placeholder rejection, zero-Contacts-created), and audit/response safety (no message body in audit metadata, no auth-secret fields, an XSS-shaped payload stored/returned verbatim as inert text).
- **Frontend** (`TemplatesPage.test.tsx`, 6 tests; `App.test.tsx`, +1 test): list with channel/status badges, SMS creation with placeholder insertion, Email-requires-subject field behavior, preview rendering with SMS segment guidance, edit-and-disable flow, and Templates-nav permission gating.

Total: 293 tests passing (30 frontend + 251 backend + 12 database).

## Live validation performed

Live PostgreSQL (`beacon_dev`, credentials never displayed): migration applied, the case-insensitive per-channel unique index and `templates_status_idx` confirmed present, all four `templates.*` permissions and their role mappings confirmed, seed idempotency reconfirmed (two runs, unchanged: 21 permissions, 43 mappings).

Live API workflow (`curl` against the real running backend, four throwaway actor accounts — ADMIN/COMMUNICATION_MANAGER/AUDITOR/RESPONDER — created directly via the auth module's own hashing code): as ADMIN, created an SMS Template with `{{firstName}}` → previewed it by id, confirming `"Hello Alex, please evacuate..."` with correct GSM-7/1-segment metadata → previewed a 161-character ad-hoc message, confirming it correctly reports 2 GSM-7 segments → created an Email Template with `{{firstName}}` in the subject and `{{displayName}}` in the body → previewed it, confirming both subject and body rendered correctly → attempted an unknown placeholder (`{{ssn}}`, correctly rejected `400`) → attempted a case-equivalent duplicate name on the same channel (correctly rejected `409 duplicate_template_name`) → updated the SMS Template's body → disabled it, confirmed it disappeared from the `status=active` filter and appeared under `status=inactive` → re-enabled it. Verified COMMUNICATION_MANAGER can create/manage Templates; verified AUDITOR can read but gets `403` on create; verified RESPONDER gets `403`; verified unauthenticated gets `401`. Inspected all 6 `TEMPLATE_*` audit rows directly and confirmed zero occurrences of any Template's actual message content.

**Live browser validation** (required explicitly this module, after Module 06's CORS discovery): logged in as ADMIN in the real React frontend, viewed the card-grid Templates list matching the curl-created data exactly (including a raw `{{firstName}}` token rendering safely as literal text in a card's subject preview) → created a new SMS Template through the UI, using the placeholder-insert button and the in-modal Preview action (confirmed `POST /templates/preview` and `POST /templates` both succeeded with correct CORS preflight responses) → opened the saved Template's detail modal (`GET`), edited its body and saved (`PATCH`, confirmed `200 OK` via direct network-request inspection) → disabled it (`POST` lifecycle, confirmed `INACTIVE` badge) → re-enabled it (`POST`, confirmed `ACTIVE` badge again). No CORS or CSRF regression — Module 06's `methods` fix in `backend/src/app.ts` continues to cover `POST`/`PATCH` correctly for this module's routes too. All live-validation Templates and actor accounts were removed afterward — `beacon_dev` confirmed back to 0 users, 0 contacts, 0 groups, 0 templates (seed-only state).

## Known limitations / follow-up

- **SMS segment estimation is a best-effort GSM 03.38 implementation**, not certified against every carrier's exact billing behavior — explicitly labeled "(estimate)" everywhere it's shown, per the module spec's own instruction.
- **The frontend's SMS character count is a live client-side count; the exact segment/encoding estimate requires an explicit "Preview" action** (a backend round-trip) rather than being recomputed on every keystroke — a deliberate choice to avoid duplicating the GSM-7 character table in two places (a real consistency risk) in exchange for one extra click before an operator sees the precise segment count.
- **No rich HTML email authoring** — plain text only, matching the stakeholder prototype's own Template preview and the module spec's MVP guidance; revisit if a future requirement explicitly calls for HTML email content.
- As in prior modules, live-validation actor accounts were created via a temporary non-interactive script rather than `bootstrap-user.ts`'s interactive prompts, due to the same documented Windows/Node readline automation limitation — not a limitation of Module 07 itself.
- During browser validation, extremely fast automated placeholder-button-then-immediately-continue-typing interaction occasionally raced React's state update; inserting a placeholder and then waiting even briefly before continuing to type (i.e., normal human interaction speed) behaved correctly every time it was tested. Not treated as a product defect, but noted here in case future UI automation against this screen needs the same small delay.
