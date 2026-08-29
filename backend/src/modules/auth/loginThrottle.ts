import type { AuthConfig } from "./config.js";

interface ThrottleEntry {
  failures: number;
  firstFailureAt: number;
  lockedUntil?: number;
}

/**
 * In-process, per-normalized-email login throttle. Applies uniformly to every submitted
 * email string — including ones that don't correspond to any real account — so a lockout
 * response never reveals whether the account exists.
 *
 * Production scaling note: this is a single-process in-memory Map, matching the current
 * single-instance modular monolith. It resets on restart and does not share state across
 * multiple instances. A horizontally-scaled deployment would need a shared store (e.g. Redis)
 * for this throttle to remain effective across all instances.
 */
export class LoginThrottle {
  private readonly entries = new Map<string, ThrottleEntry>();
  private readonly maxEntries = 10_000;

  constructor(private readonly config: AuthConfig) {}

  private normalize(email: string): string {
    return email.trim().toLowerCase();
  }

  private isStale(entry: ThrottleEntry, now: number): boolean {
    const staleAfterMs = this.config.loginLockoutWindowMs * 4;
    return now - entry.firstFailureAt > staleAfterMs && (!entry.lockedUntil || entry.lockedUntil < now);
  }

  isLocked(email: string): boolean {
    const key = this.normalize(email);
    const entry = this.entries.get(key);
    if (!entry?.lockedUntil) {
      return false;
    }
    return entry.lockedUntil > Date.now();
  }

  recordFailure(email: string): void {
    const key = this.normalize(email);
    const now = Date.now();

    if (this.entries.size > this.maxEntries) {
      // Crude safety valve against unbounded memory growth from many distinct fake emails.
      this.entries.clear();
    }

    const existing = this.entries.get(key);
    const entry = existing && !this.isStale(existing, now) ? existing : { failures: 0, firstFailureAt: now };

    entry.failures += 1;
    if (entry.failures >= this.config.loginMaxFailures) {
      entry.lockedUntil = now + this.config.loginLockoutWindowMs;
    }

    this.entries.set(key, entry);
  }

  recordSuccess(email: string): void {
    this.entries.delete(this.normalize(email));
  }
}
