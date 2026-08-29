import type { FastifyInstance } from "fastify";
import { checkDatabaseHealth } from "@beacon/database";
import type { AppEnv } from "../config/env.js";

export async function healthRoutes(app: FastifyInstance, env: AppEnv): Promise<void> {
  app.get("/health", async () => {
    const database = await checkDatabaseHealth();

    return {
      status: "ok",
      application: env.appName,
      environment: env.nodeEnv,
      timestamp: new Date().toISOString(),
      database,
    };
  });
}
