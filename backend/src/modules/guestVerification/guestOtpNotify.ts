import { getSmsProvider, getEmailProvider } from "../notifications/providers/registry.js";
import type { NotificationConfig } from "../notifications/config.js";

export interface SendOtpInput {
  challengeId: string;
  code: string;
  email: string | null;
  mobilePhone: string | null;
  incidentTitle: string;
}

/**
 * Same minimal reuse of Module 10's provider abstraction as Module 17's `guestNotify.ts` — no
 * Alert Engine involvement, mock provider is sufficient. The raw code is placed only in the
 * outbound message body handed directly to the provider adapter; it is never logged by this
 * function or by the mock adapter (which "performs no network I/O, never logs message body").
 */
export async function sendGuestOtpNotification(notificationConfig: NotificationConfig, input: SendOtpInput): Promise<boolean> {
  const body = `Your BEACON verification code for "${input.incidentTitle}" is ${input.code}. It expires soon and can only be used once.`;

  if (input.email) {
    const result = await getEmailProvider(notificationConfig).send({
      idempotencyKey: input.challengeId,
      destination: input.email,
      subject: `Your BEACON verification code`,
      body,
    });
    return result.accepted;
  }

  if (input.mobilePhone) {
    const result = await getSmsProvider(notificationConfig).send({
      idempotencyKey: input.challengeId,
      destination: input.mobilePhone,
      body,
    });
    return result.accepted;
  }

  return false;
}
