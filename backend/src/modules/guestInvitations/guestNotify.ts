import { getSmsProvider, getEmailProvider } from "../notifications/providers/registry.js";
import type { NotificationConfig } from "../notifications/config.js";
import type { GuestInvitationConfig } from "./config.js";

/**
 * A minimal, purpose-built transactional-notification sender for guest invitations — deliberately
 * bypasses the entire Alert Engine (recipient resolution, dispatch attempts, delivery tracking):
 * a guest invitation is a single direct message to a single explicit destination, not a broadcast
 * to a resolved audience, and creating a fake Alert record to carry it would misrepresent both the
 * Alert history and the Incident timeline. See claude/prompts/17-guest-invitations.md, "Notification
 * architecture". Reuses the exact same provider abstraction (`SmsSendRequest`/`EmailSendRequest` →
 * `getSmsProvider`/`getEmailProvider`) Module 10 built, so `SMS_PROVIDER=mock`/`EMAIL_PROVIDER=mock`
 * work here with zero extra wiring.
 */
export function buildInvitationUrl(config: GuestInvitationConfig, rawToken: string): string {
  const path = `/guest/invite/${rawToken}`;
  return config.portalBaseUrl ? `${config.portalBaseUrl}${path}` : path;
}

export interface SendInvitationInput {
  invitationId: string;
  guestName: string;
  email: string | null;
  mobilePhone: string | null;
  incidentTitle: string;
  invitationUrl: string;
}

/**
 * Best-effort — a delivery failure here does not roll back the already-created invitation (the
 * link is still valid if the guest obtains it by any other means, e.g. an authorized user reading
 * it aloud); the invitation's `status` simply stays `pending` rather than advancing to `sent`. The
 * raw token already lives only inside `invitationUrl`'s string value passed in by the caller and is
 * never logged here.
 */
export async function sendGuestInvitationNotification(
  notificationConfig: NotificationConfig,
  input: SendInvitationInput,
): Promise<boolean> {
  const body = `${input.guestName}, you've been invited as a guest on BEACON incident "${input.incidentTitle}". Open this link to verify: ${input.invitationUrl}`;

  if (input.email) {
    const result = await getEmailProvider(notificationConfig).send({
      idempotencyKey: input.invitationId,
      destination: input.email,
      subject: `Guest invitation: ${input.incidentTitle}`,
      body,
    });
    return result.accepted;
  }

  if (input.mobilePhone) {
    const result = await getSmsProvider(notificationConfig).send({
      idempotencyKey: input.invitationId,
      destination: input.mobilePhone,
      body,
    });
    return result.accepted;
  }

  return false;
}
