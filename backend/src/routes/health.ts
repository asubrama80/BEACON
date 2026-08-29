import type { FastifyInstance } from "fastify";
import type { AppEnv } from "../config/env.js";

export async function healthRoutes(app: FastifyInstance, env: AppEnv): Promise<void> {
  app.get("/health", async () => {
    return {
      status: "ok",
      application: env.appName,
      environment: env.nodeEnv,
      timestamp: new Date().toISOString(),
    };
  });
}
