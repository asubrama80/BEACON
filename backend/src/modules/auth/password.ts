import { hash, verify, Algorithm } from "@node-rs/argon2";
import type { AuthConfig } from "./config.js";

export async function hashPassword(password: string, config: AuthConfig): Promise<string> {
  return hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: config.argon2.memoryCost,
    timeCost: config.argon2.timeCost,
    parallelism: config.argon2.parallelism,
  });
}

export async function verifyPassword(hashValue: string, password: string): Promise<boolean> {
  try {
    return await verify(hashValue, password);
  } catch {
    // Malformed/foreign hash — treat as a non-match rather than surfacing a library error.
    return false;
  }
}

/**
 * A precomputed Argon2id hash of a fixed dummy value, used to keep login timing consistent
 * when the submitted email doesn't match any user — so no password verification is skipped
 * (and no timing signal about account existence is created) even when there is no real hash
 * to compare against. Computed lazily once per process.
 */
let dummyHashPromise: Promise<string> | undefined;

export function getDummyHash(config: AuthConfig): Promise<string> {
  dummyHashPromise ??= hashPassword("beacon-dummy-hash-for-timing-safety", config);
  return dummyHashPromise;
}
