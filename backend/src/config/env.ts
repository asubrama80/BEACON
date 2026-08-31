export interface AppEnv {
  nodeEnv: string;
  appName: string;
  host: string;
  port: number;
  corsOrigin: string;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return {
    nodeEnv: source.NODE_ENV ?? "development",
    appName: "beacon-backend",
    host: source.BACKEND_HOST ?? "0.0.0.0",
    port: Number(source.BACKEND_PORT ?? 4000),
    corsOrigin: source.CORS_ORIGIN ?? "http://localhost:5173",
  };
}

/**
 * A missing `CORS_ORIGIN` silently defaults to `http://localhost:5173` — harmless (if
 * inconvenient) in development, but a real risk in production: a deployment that forgets to set
 * it would boot with CORS/WebSocket-Origin locked to a value that can never match any real
 * frontend, or worse, could coincidentally match an attacker-controlled `localhost` during some
 * unusual deployment topology. Production must set it explicitly. Called only from the real
 * startup entrypoint (`index.ts`) — never from `buildApp()`/tests, which legitimately rely on the
 * development default. See claude/prompts/23-security-hardening.md, "Environment security".
 */
export function assertProductionEnvSafe(env: AppEnv, source: NodeJS.ProcessEnv = process.env): void {
  if (env.nodeEnv !== "production") return;
  if (!source.CORS_ORIGIN) {
    throw new Error("CORS_ORIGIN is required in production but was not set. Configure it to your real frontend origin.");
  }
}
