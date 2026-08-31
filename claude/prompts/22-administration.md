# Module 22 — Administration

## Scope

Application Administration: a safe, permission-gated surface for User/RBAC visibility, system and
security status, and two genuinely new admin-privileged security actions. Built almost entirely by
composition — User CRUD (Module 03) and Audit (Module 20) are linked to, never re-implemented.
Provider credential administration (SMS/Email/RTC provider config) is explicitly **not** in scope —
that remains Module 27's boundary, and provider configuration stays environment-driven here.

## Permissions

Two new permission codes, deliberately minimal (`database/src/permissionCodes.ts`'s
`MODULE_22_PERMISSIONS`): `admin.read` (view status/roles) and `admin.manage` (session revoke, MFA
reset). ADMIN receives both automatically (`ALL_PERMISSIONS`); AUDITOR receives `admin.read` only,
consistent with its existing read-only/compliance-review role description — it cannot revoke a
session or reset MFA. No other role was granted either code. This follows the same
minimal-permission-surface discipline as every prior module: two codes covering genuinely new
capability, not a broad `admin.*` wildcard "for convenience."

## Backend surface

Four new routes, all under `backend/src/modules/admin/` (`adminDto.ts`/`adminQueries.ts`/
`adminService.ts`/`routes.ts`), registered in `app.ts`:

| Route | Permission | Purpose |
|---|---|---|
| `GET /admin/status` | `admin.read` | Sanitized system/security/provider status |
| `GET /admin/roles` | `admin.read` | Role → permission-code mapping, with per-role User counts |
| `POST /admin/users/:id/sessions/revoke` | `admin.manage` | Force re-authentication without disabling |
| `POST /admin/users/:id/mfa/reset` | `admin.manage` | Admin-privileged MFA reset, forces re-enrollment |

### Status endpoint

`AdminStatusDto` is an explicit, individually-named field set — never a `process.env` dump or a
config-object spread. `application` (name/version/environment — version read once at module load
from `backend/package.json`, resolved relative to the file's own `import.meta.url` so it works from
both `src/` and compiled `dist/`), `database.connected` (via the existing `checkDatabaseHealth()`),
`security` (MFA availability, session TTL in hours, password minimum length, login lockout
threshold, and break-glass account presence/status — never its email or credentials),
`providers.{sms,email}` (provider *names* only, e.g. `"mock"`, sourced from
`notificationConfig`; never credentials, never editable here — Module 27's boundary), and
`collaboration.status`, hardcoded to the literal `"foundation_only"` (never a real or
prototype-flavor RTC provider name, since Modules 15/16 remain genuinely unimplemented).

### Role summaries

The existing `GET /roles`/`GET /permissions` (Module 03's `rbac/routes.ts`) return flat, unjoined
lists — no endpoint assembled "which permissions does this role have, and how many Users hold it."
`adminQueries.getRoleSummaries()` fills that gap with a single read-only query joining
`roles`/`role_permissions`/`permissions` (`array_agg(distinct permissions.code)`, wrapped in
`array_remove(..., null)` to strip nulls from the left join) plus a per-role scalar subquery
`count(*) from user_roles where role_id = roles.id`. Never writes to `role_permissions` — this
codebase's roles/permissions remain seed-managed, not runtime-editable, exactly as
`rbac/routes.ts`'s own doc comment already established; Module 22 did not change that.

### Session revoke vs. disable

`disableUser()` (Module 03) already revokes all of a User's sessions as a side effect of disabling
the account. The new `revokeUserSessions()` is for the different case: force re-authentication
(e.g., suspected session compromise) **without** deactivating the account. Both actions share a new
`assertManageableTarget()` helper (404 on a nonexistent target, reuses the existing
`assertNotBreakGlass()` guard from Module 03) before doing anything.

### Admin-privileged MFA reset

`resetUserMfa()` deletes the target's `mfaCredentials`/`mfaRecoveryCodes` rows — the identical DB
operations the existing self-service `/auth/mfa/disable` route performs — but under `admin.manage`
authorization instead of the User's own password confirmation, since an admin acting on someone
else's account cannot supply that User's password. Returns `409 mfa_not_enabled` if the target has
no active MFA credential. Never reads or exposes the TOTP secret; the target must re-enroll from
scratch afterward.

### Audit integration

Both actions record a new audit event type exactly once per call: `USER_SESSIONS_ADMIN_REVOKED`,
`MFA_ADMIN_RESET` (added to `AuthAuditEventType` in `auth/audit.ts`). The `_ADMIN_` infix
deliberately distinguishes these from any future self-service equivalent. Audit remains the
separate, authoritative history — Administration does not duplicate it into its own table; the
frontend links out to the existing Audit page instead.

## Last-admin / break-glass protections

Untouched by this module — `assertNotLastActiveAdmin()` and `assertNotBreakGlass()` continue to
gate Module 03's existing disable/role-removal/update/reset-password routes exactly as before.
Module 22's two new actions reuse `assertNotBreakGlass()` directly (a break-glass target is rejected
with `break_glass_protected`); the last-admin invariant isn't relevant to session-revoke/MFA-reset
(neither action touches role membership or account status), so no new call site was needed there.

## Frontend

`frontend/src/admin/` (`AdministrationPage.tsx`/`api.ts`/`types.ts`), matching the prototype's
card-based layout (Application/Database/Communication Providers/Collaboration Provider status
cards, a Security card) plus a genuinely new **Roles & Permissions** table (role name/code, User
count, permission codes grouped by category — Administration/Audit/Alerts/Contacts/Groups/
Templates/Incidents/Authentication-Users, purely a cosmetic display grouping that never renames the
underlying permission codes) and a **Related** section linking to the existing Users and Audit
pages rather than duplicating them. Gated behind a new `admin.read`-checked nav item in `App.tsx`,
following the identical pattern every prior module's nav addition used.

Session-revoke and MFA-reset actions were added directly into the existing
`UserDetailModal.tsx` (Module 03) as a new "Security actions" section, visible only when the
current User holds `admin.manage`, hidden entirely for the break-glass account. Both actions use
the same confirm-before-danger two-step pattern already established there for "Disable user"
(click → inline confirm/cancel → the actual mutation). MFA reset is only offered when the target's
`mfaEnabled` is true (a new field added to `UserDetail`/`UserDetailDto`, sourced from the already-
existing `findActiveMfaCredential()` query — Module 03's `loadDetail()` now fetches it alongside
everything else it already assembles).

## Privacy / secrets

`AdminStatusDto` never includes `DATABASE_URL`, password hashes, provider credentials, session
tokens/hashes, MFA secrets, or a `process.env` spread — verified both by an explicit allowlisted DTO
shape and by a backend test that scans the serialized response against a banned-pattern regex. The
break-glass status object exposes only `present`/`status`, never the account's email. Role summaries
expose only permission codes and counts, never User PII beyond what the existing `/users` endpoints
already expose.

## Tests

Backend: 593 total (up from 574) — 19 new in `admin.integration.test.ts` (unauthenticated and Guest-
cookie denial on `GET /admin/status`; `admin.read`-gated access for AUDITOR/ADMIN and denial for a
User without it; response sanitization against a banned-credential-pattern regex plus explicit
allowlisted-shape assertions; `GET /admin/roles` correctness, including AUDITOR's own `admin.read`
grant and ADMIN's `admin.manage` grant showing up in the mapping; `admin.manage`-gated denial of
both mutating actions for AUDITOR and for unauthenticated requests; session-revoke success
(subsequent `/auth/me` with the old session cookie returns `401`) with exactly-once audit event
assertion, 404 on a nonexistent target, and `break_glass_protected` rejection; MFA-reset success
using a real TOTP enrollment (the same `otpauth`/`Secret`/`TOTP` pattern Module 02's own test suite
established) with exactly-once audit event assertion and the target's `mfaEnabled` flipping to
`false` afterward, `409 mfa_not_enabled` when the target has no active credential, 404 on a
nonexistent target, and `break_glass_protected` rejection; a last-admin regression check confirming
Module 03's existing safeguard is untouched via the real `/users/:id/disable` route). Adding
`admin.read`/`admin.manage` to the seed also required updating three pre-existing hardcoded
expected-permission-array literals in `rbac/permissions.test.ts` (AUDITOR's set, the AUDITOR+
RESPONDER union count/set, and ADMIN's full set) — the same "cascading RBAC test fix" pattern every
permission-adding module since Module 04 has produced; no test assertion was weakened, only the
already-correct expected literals extended to match the new, deliberately-added permission.

Frontend: 120 total (up from 110) — 5 new in `AdministrationPage.test.tsx` (status/security/
provider rendering, credential/`process.env`-pattern absence, role-permission-mapping rendering
with user counts, Related-link navigation, error handling) and 5 new in `UserDetailModal.test.tsx`
(Security actions section hidden without `admin.manage`; shown with it, including current MFA
status; Reset MFA button absent when the target has no active MFA; session-revoke and MFA-reset
both gated behind their confirm step, never firing on the first click).

## Live validation

A temporary synthetic ADMIN (`temp-module22-admin@example.invalid`) was created via a throwaway
`backend/scripts/_temp-create-admin.ts` script and used to browser-validate the full flow: the
Administration nav item and page render real status/security/provider/role data; a second synthetic
RESPONDER target user was created through the existing Users UI; its detail modal's new "Security
actions" section correctly showed "Revoke active sessions" and "MFA: Not enabled" (no Reset MFA
button, since MFA wasn't enrolled); confirming the revoke action produced a real `200` (verified via
network-request inspection) and a corresponding `USER_SESSIONS_ADMIN_REVOKED` audit event, visible
on the real Audit page, attributed to the acting admin. Logging in as the RESPONDER target confirmed
no Administration/Users/Audit nav items render, and a direct `GET /admin/status` call returns `403
not_authorized`; an unauthenticated call returns `401 not_authenticated`. Both synthetic users and
their audit rows were deleted afterward via a throwaway cleanup script; both scratch scripts were
then deleted (never committed).

## Known limitations / follow-up

- No global session browser — deliberately scoped out per the module spec (never expose raw
  session tokens/hashes; "revoke all sessions for this User" is the only session-admin primitive).
- Role/permission mapping remains read-only; this codebase's roles/permissions stay seed-managed,
  matching the pre-existing `rbac/routes.ts` design this module did not change.
- Provider status (`providers.sms`/`providers.email`) is read-only display of the provider *name*
  already known from Module 10's config — no test-dispatch button, no credential field, no RTC
  provider settings. That entire surface is Module 27's boundary.

## Module 23 boundary

Security Hardening (23) had not started when this module completed. One relevant gap was identified
during this module's own architecture review but deliberately **not** fixed here, since it belongs
to Module 23's explicit scope (23.32): `notifications/config.ts`'s `readSmsProvider`/
`readEmailProvider` currently fall back silently to `"mock"` for any unrecognized explicit provider
value (e.g. a typo) rather than failing startup. Flagged for Module 23, not touched by Module 22.
