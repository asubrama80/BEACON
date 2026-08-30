/**
 * Provider-neutral delivery states (Module 11) — distinct from `alert_recipients.status`
 * (Module 10's submission outcome). `pending` is the only non-terminal delivery state; every
 * other value is terminal. See claude/prompts/11-delivery-tracking.md, "Submission vs delivery
 * distinction" and "Terminal-state semantics".
 */
export type DeliveryStatus = "pending" | "delivered" | "undelivered" | "bounced" | "failed";

/**
 * The broader set of statuses a raw provider EVENT may carry — includes `submitted` (Twilio's
 * queued/sending/sent/accepted callbacks), which is recorded to history for completeness but
 * never written to `alert_recipients.delivery_status` (that column only ever holds a
 * `DeliveryStatus` value).
 */
export type NormalizedEventStatus = "submitted" | DeliveryStatus;

const DELIVERY_STATUS_VALUES: readonly DeliveryStatus[] = ["pending", "delivered", "undelivered", "bounced", "failed"];

export function isDeliveryStatus(value: string): value is DeliveryStatus {
  return (DELIVERY_STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * Monotonic precedence rank — the entire out-of-order/terminal-state protection rule is "only
 * update current state if the incoming status's rank is strictly greater than the current rank."
 * `pending` is rank 0 (non-terminal); every terminal outcome shares rank 1. This means: a first
 * terminal event always wins; a second, later terminal event (even a "better" or "worse" one)
 * never overwrites it; and a stale/out-of-order `pending`-equivalent arriving after a terminal
 * event can never regress it. See claude/prompts/11-delivery-tracking.md, "Out-of-order event
 * handling" for the full reasoning — this is a deliberately simple, explicit, testable rule
 * rather than a timestamp-trust-dependent one (provider timestamps are not always present/
 * trustworthy — see module doc "Delivery timestamps").
 */
const RANK: Record<DeliveryStatus, number> = {
  pending: 0,
  delivered: 1,
  undelivered: 1,
  bounced: 1,
  failed: 1,
};

export function isTerminalDeliveryStatus(status: DeliveryStatus): boolean {
  return status !== "pending";
}

/** True only when adopting `next` as the new current state is a valid, non-regressive progression. */
export function isProgression(current: DeliveryStatus | null, next: DeliveryStatus): boolean {
  const currentRank = current ? RANK[current] : -1;
  return RANK[next] > currentRank;
}
