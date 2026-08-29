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
