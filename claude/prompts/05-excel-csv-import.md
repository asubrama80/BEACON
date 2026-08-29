# Module 05 — Excel/CSV Contact Import

## Scope

A safe, operator-reviewed bulk Contact import workflow for CSV and XLSX spreadsheets: upload → parse → map columns → validate/normalize/detect duplicates → preview → operator decision → confirm → persist → summary/audit. Uploading or parsing a file never creates a Contact by itself — only an explicit, authenticated confirm step does, and only for rows the operator actually selected. Import reuses Module 04's own validation, normalization, duplicate-detection, and creation logic rather than duplicating it. Groups (Module 06) and anything about sending alerts (Module 09) are out of scope and not touched.

## Architecture

```
backend/src/modules/contactImport/
  config.ts          Upload/row/column limits and batch TTL (env-overridable)
  parsing.ts          Safe CSV (csv-parse) and XLSX (exceljs) parsing, bounded by config
  mapping.ts           Header normalization, conservative auto-mapping, mapping validation
  dto.ts                Explicit response DTOs
  batchQueries.ts       DB access for contact_import_batches / contact_import_rows
  preview.ts             Reuses Module 04's validateName/normalizeChannelFields/findLikelyDuplicates
  service.ts              Orchestration: upload/preview/get/confirm, ownership, expiry, audit
  routes.ts                4 HTTP endpoints (see API summary)
database/src/schema/contactImportBatches.ts   contact_import_batches, contact_import_rows
```

`backend/src/modules/contacts/service.ts` was extended (not changed) to `export` two functions it already had — `validateName` and `normalizeChannelFields` — specifically so this module could call the exact same logic instead of reimplementing it. No existing Module 04 behavior changed; verified by rerunning Module 04's full test suite unmodified except for one pre-existing test whose hardcoded ADMIN permission list needed the new `contacts.import` code added (the same kind of update Module 04 itself required of Module 03's tests).

## API summary — 4 endpoints, not the 3 sketched in the spec

The spec's conceptual endpoint list (`POST /contacts/import/preview`, `GET /contacts/import/:batchId`, `POST /contacts/import/:batchId/confirm`) explicitly allowed following "existing project conventions" on exact paths. Splitting **upload** (parse + store raw rows, return headers/sample/suggested mapping) from **preview** (apply the operator's confirmed mapping, run validation/normalization/duplicate-detection, persist per-row results) turned out to be necessary, not optional: the workflow diagram itself puts "Map" *before* "Validate/Normalize/Detect duplicates/Preview," so a mapping has to exist before a preview can be computed, and HTTP is stateless — the file has to be parsed and its rows held server-side somewhere between those two round trips. Four endpoints:

| Method | Path | Permission | Effect |
| --- | --- | --- | --- |
| POST | `/contacts/import/upload` | `contacts.import` | Multipart file upload. Parses only; creates a batch (`status: mapping`); returns headers, up to 5 sample rows, and a suggested mapping. **Creates no Contact.** |
| POST | `/contacts/import/:batchId/preview` | `contacts.import` | Body: `{ mapping }`. Validates the mapping, computes every row's status via Module 04 logic + in-file duplicate detection, persists the computed rows (`status: previewed`). **Creates no Contact.** Can be called again if the operator changes the mapping. |
| GET | `/contacts/import/:batchId` | `contacts.import` | Paginated, filterable row listing plus batch metadata/summary — used for the Results step and for re-fetching preview pages. |
| POST | `/contacts/import/:batchId/confirm` | `contacts.import` | Body: `{ decisions: [{ rowId, selected, confirmDuplicate? }] }`. Only endpoint that ever creates Contacts. |

All four require `authenticate` + `requirePermission("contacts.import")`; the three mutating ones (`upload`, `preview`, `confirm`) additionally call `requireCsrf`.

## Safe file handling

- **No filesystem interaction at all** — the uploaded file is streamed into memory via `@fastify/multipart` (`file.toBuffer()`), parsed, and only its extracted text values (headers + cell strings) are ever persisted, never the original binary. There is no temp-file path to traverse and no on-disk artifact to clean up.
- **Size limit**: `@fastify/multipart` is registered globally with `limits.fileSize` from `ContactImportConfig` (default 5 MB, `CONTACT_IMPORT_MAX_FILE_SIZE_BYTES`); the upload handler additionally catches the truncation the plugin produces past that limit and turns it into a clean `400 import_file_invalid` instead of a raw stream error.
- **Row/column limits**: `parsing.ts` rejects a file with more than `CONTACT_IMPORT_MAX_ROWS` (default 2000) data rows or `CONTACT_IMPORT_MAX_COLUMNS` (default 40) columns, and rejects duplicate, empty, or header-only files.
- **Filename**: only ever used as a display string (`fileName`, stripped of `/`/`\`, length-capped) — never as a filesystem path.
- **Extension**: only `.csv` and `.xlsx` are accepted (`detectFileType`); legacy `.xls` is explicitly rejected — the spec's low bar for supporting it ("only if there's a compelling low-risk reason") wasn't met.

## Formula and macro safety

- **CSV** has no formula/macro concept at all — it's pure delimited text (`csv-parse`).
- **XLSX**: parsed with `exceljs`'s `Workbook.xlsx.load(buffer)`, which reads the OOXML zip/XML structure in memory and performs **no network I/O** — there is nothing that could "fetch an external workbook reference." Macros are structurally impossible: the `.xlsx` container format cannot hold them (that requires the separate `.xlsm` format, which this module doesn't accept). Formula cells are read via their **cached last-computed result** only (`cell.value.result`) — the formula string itself is never evaluated, executed, or even stored anywhere past the initial parse. A formula that errored in the source spreadsheet (a `{ error: "#DIV/0!" }`-shaped result) is treated as an empty cell rather than guessed at. Verified with a real uploaded workbook containing a formula cell during live validation (see below) — its cached string result came through correctly and the formula text never appeared anywhere in the response.
- **CSV formula injection** (a cell value like `=cmd|...` being later opened in Excel and auto-executed): out of scope for this module, since it only ever *displays* imported values inside BEACON's own UI/API — it never regenerates a CSV/XLSX file for re-download. Documented here as a reminder for whichever future module first adds Contact export.

## Column mapping

`ALLOWED_DESTINATION_FIELDS` is a hard six-item allowlist (`firstName`, `lastName`, `email`, `mobilePhone`, `department`, `referenceId`) — the exact set of Module 04's writable Contact fields. It's enforced twice: as a JSON-schema `enum` on the preview request body (so a request naming `id`, `createdAt`, `deletedAt`, or anything from `users`/`roles`/`groups`/`alerts` is rejected before any handler code runs), and again by `validateMapping()` (unknown source headers, a destination used twice, or a missing required field all reject with `400 import_mapping_invalid`). Auto-mapping (`suggestMapping`) is conservative exact-match-after-normalization only (trim/lowercase/strip spacing-punctuation) against a small fixed dictionary — never fuzzy, never AI-assisted; an unrecognized header simply suggests nothing and waits for the operator.

## Duplicate detection

- **Against the database**: reuses Module 04's `findLikelyDuplicates()` unchanged — a row whose normalized email or phone matches an existing Contact is `possible_duplicate`, carrying the same `{id, displayName, matchedOn}` shape Module 04's create-Contact 409 already returns.
- **Within the uploaded file**: `preview.ts` tracks normalized emails/phones seen so far as it walks the rows in order; a later row repeating an earlier row's normalized value becomes `duplicate_in_file`, with a reason naming the earlier row's number (e.g. "also seen at row 6") — the *first* occurrence keeps its own independent status (`valid` or `possible_duplicate`).
- Neither kind is ever silently collapsed or merged — an operator can explicitly approve a `possible_duplicate` or `duplicate_in_file` row for import, which creates a genuinely separate Contact (via Module 04's `confirmDuplicate: true` path), exactly as verified live below.

## Row statuses and priority

Each row ends up in exactly one of four states, in this precedence: `invalid` (name/email/phone validation failed) → `duplicate_in_file` → `possible_duplicate` → `valid`. Default selection: `valid` rows start selected; everything else starts unselected and requires the operator to opt in.

## Preview/confirm separation — the client never supplies Contact data

Per row, the server persists its own computed, validated, normalized values in `contact_import_rows`. The confirm request body is `{ decisions: [{ rowId, selected, confirmDuplicate? }] }` — row IDs and boolean flags only. Confirm re-reads each row from the database and decides what to do using *its own* stored `status`, never anything the client could have forged:

- `status = invalid` rows can never be imported, no matter what `selected` says — verified live by deliberately sending `selected: true` for an invalid row and confirming it came back `skipped`.
- `status ∈ {possible_duplicate, duplicate_in_file}` rows require **both** `selected: true` **and** `confirmDuplicate: true` in that row's decision to be imported.
- Each importable row is created by calling Module 04's real `createContact()` — the same function the ordinary Contacts UI calls — never a parallel insert path.

## Batch lifecycle

`contact_import_batches.status`: `mapping` → `previewed` → `confirmed` → `completed` (or `failed` on an unexpected error mid-confirm) — plus a side path to `expired`. `confirmed` is set by `claimBatchForConfirm()`, a single `UPDATE ... WHERE status = 'previewed'` — the `WHERE` clause makes double-confirm and confirm-replay structurally impossible (a second or concurrent attempt always affects zero rows and gets a clear `409 import_batch_not_previewable`), not just app-level-checked. Every batch carries `expiresAt` (`createdAt` + `CONTACT_IMPORT_BATCH_TTL_MINUTES`, default 30); any access to a non-terminal batch past that time is rejected with `410 import_batch_expired` and immediately purges the batch's PII (see below). Ownership: `loadOwnedBatch()` requires `batch.createdBy === actorId` for every operation, **with no role-based bypass** — not even ADMIN can preview, view, or confirm another operator's batch. This was a deliberate reading of the spec's "unauthorized operator cannot confirm another operator's batch," which didn't carve out an admin exception, and adding one would have meant a hard-coded role check this project explicitly avoids.

## Transaction behavior — honestly not all-or-nothing

Confirm processes selected rows one at a time in `rowIndex` order; each row's `createContact()` call either succeeds or is caught and recorded as `failed` (with a safe, generic message — never a raw DB error), and processing continues to the next row regardless. This is a deliberate choice, not an oversight: the spec explicitly warned against claiming all-or-nothing semantics without actually implementing them, and a single wrapping transaction across N independent Contact creations (each of which also writes its own audit row) would have added real complexity for a benefit — "nothing happens if row 47 of 2000 fails" — that doesn't obviously outweigh "you lose the 46 that succeeded, and have to figure out which 47 without re-running the whole file." The response and the stored per-row `importResult` always report the true state: `imported` / `skipped` / `failed`, never a fabricated blanket outcome.

## Privacy / PII handling

- **Audit metadata never contains PII**: `CONTACT_IMPORT_PREVIEWED` carries only `{fileType, total, valid, invalid, possibleDuplicate, duplicateInFile}`; `CONTACT_IMPORT_COMPLETED`/`FAILED` carry only `{fileType, total, imported, skipped, failed}` — no names, emails, phone numbers, or raw rows. Verified live via a direct `JSON.stringify` scan of the actual audit rows.
- **PII purge**: immediately after confirm finishes (success *or* failure) — and lazily whenever an expired batch is next touched — `purgeBatchPii()` nulls the batch's `rawRows` and every row's `firstName`/`lastName`/`email`/`mobilePhone`/`department`/`referenceId`/`duplicateMatches`. What's left (`status`, `importResult`, `importedContactId`, `rowIndex`) is enough to render the Results step and answer "what happened to row N" without holding onto the underlying contact data any longer than the review workflow needs it. Verified live: a completed batch's `rawRows` and a confirmed row's PII columns are `null` in the database immediately after confirm.
- **No PII in server logs**: no `console.log`/logger call anywhere in this module ever receives a row, a batch's raw content, or a parsed cell value (grep-verified).
- **Test fixtures**: every example email/phone/name used in tests and in this document is synthetic (`@example.invalid`, obviously fake names) — nothing resembling a real person.

## Database

Migration `0005_yummy_major_mapleleaf.sql` (new tables only — no existing table touched):

- **`contact_import_batches`** — `id`, `createdBy` (FK → `users.id`, `onDelete: cascade`), `fileName`, `fileType` (`csv`/`xlsx` check), `status` (6-value check), `headers` (jsonb), `rawRows` (jsonb, nullable — purged), `columnMapping` (jsonb), `rowCount`, `summary` (jsonb), `createdAt`, `expiresAt`, `confirmedAt`. Indexes on `createdBy` and `status`.
- **`contact_import_rows`** — `id`, `batchId` (FK → batches, cascade), `rowIndex`, the six Contact fields (nullable, purged post-completion), `status` (4-value check), `reasons` (jsonb), `duplicateMatches` (jsonb), `selected`, `importedContactId`, `importResult` (3-value check), `importError`, `createdAt`. Indexes on `batchId` and `(batchId, status)`.

No uploaded binary is ever stored in PostgreSQL (or anywhere) — `rawRows` holds only the extracted text values, and only until the batch completes or expires.

## Permissions

New code `contacts.import` (`MODULE_05_PERMISSIONS` in `database/src/permissionCodes.ts`, its own module file per the established per-module-owns-its-permissions convention, even though the resource prefix is still `contacts`). Grants, exactly matching the spec's recommendation:

| Role | Grant | Why |
| --- | --- | --- |
| ADMIN | yes | Full administrative access, consistent with every other permission. |
| COMMUNICATION_MANAGER | yes | Already owns `contacts.create`/`contacts.update` for maintaining the directory; bulk import is the same responsibility at scale. |
| AUDITOR | no | Read-only role; import is a write/create action. |
| INCIDENT_COMMANDER | no | Has `contacts.read` only for incident-response visibility; no standing need to bulk-create contacts. |
| RESPONDER | no | No contacts access at all. |

Seed is idempotent — live-verified (two `db:seed` runs, unchanged: 12 permissions, 21 role-permission mappings).

## Mass-assignment defense

Same two-layer Module 03/04 pattern: every mutating JSON body schema sets `additionalProperties: false` (multipart upload has no JSON body to spread in the first place), and `service.ts` never spreads a raw request body into a DB write — every field is read and validated explicitly.

## Frontend

`frontend/src/contactImport/` — a 5-step wizard (`ContactImportPage.tsx` orchestrating `ImportUploadStep` → `ImportMappingStep` → `ImportPreviewStep` → `ImportConfirmStep` → `ImportResultsStep`), styled with the prototype's stat-card/dropzone visual language (adapted into `ContactImportPage.css`, importing the shared `adminUi.css`) without redesigning any existing screen. Reachable via a permission-gated "Import Contacts" button on `ContactsPage` (`contacts.import`), which swaps the page's own content for the wizard rather than adding a new top-level nav item — Contacts and its bulk-import path stay together. The Preview step paginates (25 rows/page, matching `getImportBatch`) rather than rendering the whole file's rows in the DOM at once. Row-selection/duplicate-approval state is lifted to the top-level page component so it survives pagination. Frontend permission checks are UX-only — every action still calls the real, independently-authorizing API.

Deliberately deviated from the stakeholder prototype's static Import screen in two ways, both required by the module spec: it supports `.csv`/`.xlsx` only (the prototype's copy also mentions `.xls`, which Module 05 explicitly excludes), and it never reports an "Existing Updated" count (the prototype's mock stats include one) — this module is strictly create-oriented; existing Contacts are never automatically updated by an import.

## Security review performed

- Grepped the whole `contactImport` module for `fs`/`path.join`/`writeFile`/`readFile` — none found; there is no filesystem interaction to have a path-traversal or temp-file-cleanup bug in.
- Grepped for `console.*` — none found; nothing in this module can leak PII into server logs.
- Grepped for role-name checks (`role.code ===`, `role ===`) — none found.
- Confirmed all 4 routes chain `authenticate` + `requirePermission("contacts.import")`, and exactly the 3 mutating ones call `requireCsrf`.
- Confirmed the one `sql` template in `batchQueries.ts` (`count(*)::int`) has no interpolated value — no SQL-injection surface; every other query uses Drizzle's parameterized builder.
- Verified live and in tests: upload alone creates no Contact; preview alone creates no Contact; an invalid row can't be smuggled through confirm via `selected: true`; a `possible_duplicate`/`duplicate_in_file` row requires explicit `confirmDuplicate: true`, never just `selected: true`; a batch can't be confirmed twice; an expired batch is rejected; one operator cannot preview/view/confirm another operator's batch (including cross-role, not just cross-user).
- Verified no PII in audit metadata (live scan) and no Contact/import data in any server log.
- Confirmed this module implements nothing from Module 06 (no groups) or Module 09 (no send/notify logic) by review.

## Tests

- **Unit** (`backend/src/test/contactImport/parsing.test.ts`, 15 tests): CSV/XLSX parsing correctness, header/row trimming, empty/header-only/duplicate-header/oversized rejection, formula-cell cached-value extraction, formula-error-cell handling, malformed-file rejection.
- **Unit** (`mapping.test.ts`, 8 tests): auto-mapping suggestions (including case/spacing normalization and "no suggestion for ambiguous headers"), mapping validation (missing required field, unknown column, duplicate destination, disallowed destination).
- **Integration** (`routes.integration.test.ts`, 27 tests, live `beacon_dev`): full RBAC matrix (ADMIN/COMMUNICATION_MANAGER allowed; AUDITOR/INCIDENT_COMMANDER/RESPONDER/unauthenticated denied), upload-never-creates-a-Contact, unsupported/oversized/empty/header-only file rejection, real XLSX round-trip, mapping-allowlist enforcement at the schema layer, preview correctness (statuses, normalization, counts, zero Contacts created), database and in-file duplicate detection (both fields, case-insensitive), full confirm flow (valid rows imported, invalid/duplicate rows skipped, an invalid row's forged `selected: true` ignored, explicit duplicate approval creates a separate Contact), double-confirm rejection, cross-operator batch-access rejection (preview/get/confirm), un-previewed-batch confirm rejection, batch expiry rejection, audit-trail PII-safety, and post-completion PII purge.
- **Frontend** (`ContactImportPage.test.tsx`, 2 tests; `ContactsPage.test.tsx`, +2 tests): the full upload→map→preview→confirm→results wizard flow via a real synthetic `File`/`FormData`, a duplicate-row requiring explicit approval before it can be selected, and Import-button permission gating (hidden without `contacts.import`, shown and functional with it).

Total: 205 tests passing (18 frontend + 175 backend + 12 database).

## Live validation performed

Live PostgreSQL (`beacon_dev`, credentials never displayed): migration applied, `contact_import_batches`/`contact_import_rows` and their indexes/constraints confirmed present, `contacts.import` permission and its ADMIN/COMMUNICATION_MANAGER mappings confirmed, seed idempotency reconfirmed (two runs, unchanged: 12 permissions, 21 mappings).

Live workflow (`curl` against the real running backend, three throwaway actor accounts created directly via the auth module's own hashing code): as ADMIN, uploaded a synthetic 10-row CSV covering every case from the spec (valid US phone, valid international phone, mixed-case/whitespace email, invalid email, invalid phone, in-file duplicate email, in-file duplicate phone, and a database duplicate against a contact created beforehand) → confirmed zero Contacts existed after upload and after preview → reviewed the computed statuses (5 valid / 2 invalid / 2 duplicate-in-file / 1 possible-duplicate, all correct) → confirmed with a deliberate attempt to smuggle an invalid row through via `selected: true` (correctly skipped) and explicit approval of the database-duplicate row (correctly imported as a separate Contact) → verified the resulting 6 new Contacts, the two `CONTACT_IMPORT_*` audit rows (PII-free), the batch's `completed` status, and the purged `rawRows`/row-PII → attempted to confirm the same batch again (correctly rejected, `409`). Repeated the essential upload→preview→confirm sequence for a real XLSX workbook, including one formula cell (its cached string result came through correctly, the formula text nowhere in the response). Verified COMMUNICATION_MANAGER can upload/preview/confirm; verified RESPONDER gets `403`; verified COMMUNICATION_MANAGER cannot access ADMIN's batch (`403`). Repeated the full upload→map→preview(with a real-time database-duplicate match against a phone number created earlier in the same session)→approve-duplicate→confirm→results sequence through the **actual React frontend in a real browser**, using a synthetically-constructed `File`/`DataTransfer` to drive the real file input (Chrome/browser-automation sandboxing prevents scripting a real OS file-picker dialog, so the file was constructed in-page rather than picked from disk — the resulting upload still went through the real multipart endpoint end-to-end). All live-validation Contacts, import batches/rows, audit rows, and actor accounts were removed afterward — `beacon_dev` confirmed back to 0 users, 0 contacts, 0 import batches (seed-only state).

## Known limitations / follow-up

- **Duplicate-lookup performance at scale**: `findLikelyDuplicates()` is called once per row during preview (not batched into a single query across the whole file). Fine at the current row cap (2000) in local testing; a future optimization for very large imports would batch all normalized emails/phones into one query. Documented rather than built now, per the "don't overengineer" guidance.
- **Full batch-row deletion after completion**: today, a completed/expired batch's row is retained (PII-purged) rather than deleted outright; there's no scheduled cleanup job removing old batch/row shells entirely. A periodic cleanup script (mirroring `db:seed`'s pattern) is a reasonable, deliberately deferred follow-up rather than something this module needed to build.
- **Real file-picker interaction** wasn't exercised in the browser-automation environment (see Live validation above) — the underlying multipart upload endpoint itself was still driven end-to-end through the real browser and real backend, just with an in-page-constructed `File` object standing in for an OS-level file selection.
- As in prior modules, live-validation actor accounts were created via a temporary non-interactive script rather than `bootstrap-user.ts`'s interactive prompts, due to the same documented Windows/Node readline automation limitation — not a limitation of Module 05 itself.
