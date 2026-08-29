export interface AuthConfig {
  sessionCookieName: string;
  csrfCookieName: string;
  sessionTtlSeconds: number;
  cookieSecure: boolean;
  argon2: {
    memoryCost: number;
    timeCost: number;
    parallelism: number;
  };
  mfaIssuer: string;
  passwordMinLength: number;
  loginMaxFailures: number;
  loginLockoutWindowMs: number;
  loginRateLimitMax: number;
  loginRateLimitWindow: string;
}

export function loadAuthConfig(source: NodeJS.ProcessEnv = process.env): AuthConfig {
  const nodeEnv = source.NODE_ENV ?? "development";

  return {
    sessionCookieName: "beacon_session",
    csrfCookieName: "beacon_csrf",
    sessionTtlSeconds: Number(source.SESSION_TTL_HOURS ?? 12) * 60 * 60,
    cookieSecure: nodeEnv === "production",
    argon2: {
      memoryCost: Number(source.ARGON2_MEMORY_COST ?? 19456),
      timeCost: Number(source.ARGON2_TIME_COST ?? 2),
      parallelism: Number(source.ARGON2_PARALLELISM ?? 1),
    },
    mfaIssuer: source.MFA_ISSUER ?? "BEACON",
    passwordMinLength: Number(source.PASSWORD_MIN_LENGTH ?? 12),
    loginMaxFailures: Number(source.LOGIN_MAX_FAILURES ?? 5),
    loginLockoutWindowMs: Number(source.LOGIN_LOCKOUT_WINDOW_MINUTES ?? 15) * 60 * 1000,
    loginRateLimitMax: Number(source.LOGIN_RATE_LIMIT_MAX ?? 10),
    loginRateLimitWindow: source.LOGIN_RATE_LIMIT_WINDOW ?? "1 minute",
  };
}

/** Throws a clear, config-only error if MFA_ENCRYPTION_KEY is missing or the wrong size. */
export function loadMfaEncryptionKey(source: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = source.MFA_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "MFA_ENCRYPTION_KEY is required but was not set. Copy .env.example to .env and configure it " +
        "(32 random bytes, base64-encoded — e.g. `node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"`).",
    );
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("MFA_ENCRYPTION_KEY must decode to exactly 32 bytes (base64-encoded).");
  }

  return key;
}
