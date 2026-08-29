import Fastify, { type FastifyInstance } from "fastify";
import { closeDb } from "@beacon/database";
import { loadEnv, type AppEnv } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";

export function buildApp(env: AppEnv = loadEnv()): FastifyInstance {
  const app = Fastify({ logger: env.nodeEnv !== "test" });

  app.register((instance) => healthRoutes(instance, env));

  app.addHook("onClose", async () => {
    await closeDb();
  });

  return app;
}
