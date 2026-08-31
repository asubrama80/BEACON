import type { Database } from "@beacon/database";
import { AuthError } from "../auth/errors.js";
import { recordAuthEvent } from "../auth/audit.js";
import { appendTimelineEvent } from "../incidents/timelineQueries.js";
import { hashInvitationToken } from "../guestInvitations/token.js";
import { findPublicInvitationByTokenHash, markInvitationVerified, type PublicLookupRow } from "../guestInvitations/guestInvitationQueries.js";
import { maskDestination } from "../guestInvitations/maskDestination.js";
import { enrollVerifiedGuestParticipant } from "../incidents/service.js";
import type { NotificationConfig } from "../notifications/config.js";
import type { GuestVerificationConfig } from "./config.js";
import { generateOtp, generateOtpSalt, hashOtp, verifyOtp as checkOtp } from "./otp.js";
import { generateGuestSessionToken, hashGuestSessionToken } from "./guestSessionToken.js";
import { sendGuestOtpNotification } from "./guestOtpNotify.js";
import {
  supersedeActiveChallenges,
  insertChallenge,
  findActiveChallenge,
  recordFailedAttempt,
  consumeChallenge,
  getChallengeStatus,
  insertGuestSession,
  revokeGuestSession,
} from "./guestVerificationQueries.js";
import type { OtpRequestedResult } from "./guestVerificationDto.js";

/** Shared invitation-validity gate for both requestOtp and verifyOtp — deliberately does NOT
 * reject an already-`verified`/`joined` invitation, so a Guest whose session later expires can
 * request a fresh OTP and re-authenticate rather than being permanently locked out. See
 * claude/prompts/18-otp-verification.md, "Re-authentication after session expiry". */
async function assertInvitationUsable(db: Database, token: string): Promise<PublicLookupRow> {
  const tokenHash = hashInvitationToken(token);
  const lookup = await findPublicInvitationByTokenHash(db, tokenHash);
  if (!lookup) {
    throw new AuthError(404, "invitation_not_found", "This invitation link is not valid.");
  }
  if (lookup.revokedAt || lookup.status === "revoked") {
    throw new AuthError(409, "invitation_revoked", "This invitation has been revoked.");
  }
  if (lookup.expiresAt.getTime() < Date.now() || lookup.status === "expired") {
    throw new AuthError(409, "invitation_expired", "This invitation link has expired.");
  }
  if (lookup.incidentStatus === "closed") {
    throw new AuthError(409, "incident_closed", "This incident is closed; guest access is no longer available.");
  }
  return lookup;
}

export interface RequestOtpOptions {
  /** Test-only capture seam — mirrors `BuildAppOptions.sesFetchCert`'s established pattern. Never
   * wired to any production request path; only `buildTestApp()` ever supplies it. */
  onOtpGenerated?: (code: string) => void;
}

export async function requestOtp(
  db: Database,
  config: GuestVerificationConfig,
  notificationConfig: NotificationConfig,
  token: string,
  options: RequestOtpOptions = {},
): Promise<OtpRequestedResult> {
  const lookup = await assertInvitationUsable(db, token);

  const existingActive = await findActiveChallenge(db, lookup.id);
  if (existingActive) {
    const cooldownEndsAt = existingActive.issuedAt.getTime() + config.otpResendCooldownSeconds * 1000;
    if (cooldownEndsAt > Date.now()) {
      throw new AuthError(429, "otp_resend_too_soon", "Please wait before requesting another code.");
    }
  }

  const code = generateOtp();
  options.onOtpGenerated?.(code);
  const salt = generateOtpSalt();
  const codeHash = hashOtp(code, salt);
  const expiresAt = new Date(Date.now() + config.otpTtlMinutes * 60 * 1000);

  const { issuedAt } = await db.transaction(async (tx) => {
    await supersedeActiveChallenges(tx, lookup.id);
    return insertChallenge(tx, { invitationId: lookup.id, codeSalt: salt, codeHash, expiresAt });
  });

  const delivered = await sendGuestOtpNotification(notificationConfig, {
    challengeId: lookup.id,
    code,
    email: lookup.email,
    mobilePhone: lookup.mobilePhone,
    incidentTitle: lookup.incidentTitle,
  });

  await recordAuthEvent(db, {
    eventType: "GUEST_OTP_REQUESTED",
    actorType: "guest",
    actorId: lookup.id,
    resourceType: "guest_invitation",
    resourceId: lookup.id,
    incidentId: lookup.incidentId,
    metadata: { channel: lookup.email ? "email" : "sms", delivered },
  });

  return {
    maskedDestination: maskDestination(lookup.email, lookup.mobilePhone),
    resendAvailableAt: new Date(issuedAt.getTime() + config.otpResendCooldownSeconds * 1000).toISOString(),
    otpExpiresAt: expiresAt.toISOString(),
  };
}

export interface VerifyOtpResult {
  sessionToken: string;
  sessionExpiresAt: string;
  guestName: string;
  incidentId: string;
}

export async function verifyOtp(
  db: Database,
  config: GuestVerificationConfig,
  token: string,
  code: string,
): Promise<VerifyOtpResult> {
  const lookup = await assertInvitationUsable(db, token);

  const challenge = await findActiveChallenge(db, lookup.id);
  if (!challenge) {
    throw new AuthError(400, "otp_expired", "This code has expired or was never requested. Please request a new one.");
  }
  if (challenge.expiresAt.getTime() < Date.now()) {
    throw new AuthError(400, "otp_expired", "This code has expired. Please request a new one.");
  }

  const valid = checkOtp(code, challenge.codeSalt, challenge.codeHash);
  if (!valid) {
    const { lockedNow } = await recordFailedAttempt(db, challenge.id, config.otpMaxAttempts);
    if (lockedNow) {
      await recordAuthEvent(db, {
        eventType: "GUEST_VERIFICATION_FAILED_LIMIT",
        actorType: "guest",
        actorId: lookup.id,
        resourceType: "guest_invitation",
        resourceId: lookup.id,
        incidentId: lookup.incidentId,
      });
      throw new AuthError(429, "otp_attempts_exceeded", "Too many incorrect attempts. Please request a new code.");
    }
    throw new AuthError(400, "otp_invalid", "That code is incorrect.");
  }

  const sessionToken = generateGuestSessionToken();
  const sessionHash = hashGuestSessionToken(sessionToken);
  const sessionExpiresAt = new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000);

  await db.transaction(async (tx) => {
    const consumed = await consumeChallenge(tx, challenge.id);
    if (!consumed) {
      // Lost the race to a concurrent correct submission of the same code — legitimate, not an
      // error, as long as the challenge is now genuinely `consumed` (not locked/expired/superseded
      // for some other reason). See claude/prompts/18-otp-verification.md, "Concurrent verification".
      const currentStatus = await getChallengeStatus(tx, challenge.id);
      if (currentStatus !== "consumed") {
        throw new AuthError(400, "otp_expired", "This code has expired. Please request a new one.");
      }
    }

    const firstTimeVerified = await markInvitationVerified(tx, lookup.id);
    await insertGuestSession(tx, { invitationId: lookup.id, tokenHash: sessionHash, expiresAt: sessionExpiresAt });

    if (firstTimeVerified) {
      await appendTimelineEvent(tx, { incidentId: lookup.incidentId, eventType: "GUEST_VERIFIED" });
      // Module 19 — the invitation itself already represents explicit participation
      // authorization, so first-time verification auto-enrolls the Guest onto the roster. Gated
      // on `firstTimeVerified` for the same reason as the timeline event above: a later
      // re-authentication (session expired, guest logs back in) must never resurrect a
      // participant a manager has since removed. See
      // claude/prompts/19-participant-management.md, "Auto-enrollment".
      await enrollVerifiedGuestParticipant(tx, lookup.incidentId, lookup.id);
    }
  });

  await recordAuthEvent(db, {
    eventType: "GUEST_VERIFICATION_SUCCEEDED",
    actorType: "guest",
    actorId: lookup.id,
    resourceType: "guest_invitation",
    resourceId: lookup.id,
    incidentId: lookup.incidentId,
  });

  return {
    sessionToken,
    sessionExpiresAt: sessionExpiresAt.toISOString(),
    guestName: lookup.guestName,
    incidentId: lookup.incidentId,
  };
}

export async function logoutGuest(db: Database, guestSessionId: string, invitationId: string, incidentId: string): Promise<void> {
  await revokeGuestSession(db, guestSessionId);
  await recordAuthEvent(db, {
    eventType: "GUEST_SESSION_REVOKED",
    actorType: "guest",
    actorId: invitationId,
    resourceType: "guest_invitation",
    resourceId: invitationId,
    incidentId,
    metadata: { reason: "logout" },
  });
}
