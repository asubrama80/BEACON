import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { closeDb } from "@beacon/database";
import { loadEnv, type AppEnv } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";
import { loadAuthConfig, loadMfaEncryptionKey, type AuthConfig } from "./modules/auth/config.js";
import { authRoutes } from "./modules/auth/routes.js";
import { AuthError } from "./modules/auth/errors.js";
import { usersRoutes } from "./modules/users/routes.js";
import { rbacRoutes } from "./modules/rbac/routes.js";
import { contactsRoutes } from "./modules/contacts/routes.js";

export interface BuildAppOptions {
  env?: AppEnv;
  authConfig?: AuthConfig;
  mfaEncryptionKey?: Buffer;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const env = options.env ?? loadEnv();
  const authConfig = options.authConfig ?? loadAuthConfig();
  const mfaEncryptionKey = options.mfaEncryptionKey ?? loadMfaEncryptionKey();

  const app = Fastify({ logger: env.nodeEnv !== "test" });

  app.register(cookie);
  // credentials:true is required so the browser sends/accepts the session and CSRF cookies
  // across the frontend/backend origin split in local dev (Vite on :5173, API on :4000).
  // origin is an explicit allow-list (never "*") because credentials:true forbids a wildcard.
  app.register(cors, { origin: env.corsOrigin, credentials: true });
  app.register(rateLimit, { global: false });

  app.register((instance) => healthRoutes(instance, env));
  app.register((instance) => authRoutes(instance, { config: authConfig, mfaEncryptionKey }));
  app.register((instance) => usersRoutes(instance, { config: authConfig }));
  app.register((instance) => rbacRoutes(instance, { config: authConfig }));
  app.register((instance) => contactsRoutes(instance, { config: authConfig }));

  app.setErrorHandler((error: FastifyError | AuthError, request, reply) => {
    if (error instanceof AuthError) {
      reply.status(error.statusCode).send(error.toResponse());
      return;
    }

    if (error.validation) {
      reply.status(400).send({ error: "invalid_request", message: error.message });
      return;
    }

    if (error.statusCode === 429) {
      reply.status(429).send({ error: "too_many_attempts", message: "Too many requests. Try again later." });
      return;
    }

    request.log.error(error);
    reply.status(500).send({ error: "internal_error", message: "Something went wrong. Please try again." });
  });

  app.addHook("onClose", async () => {
    await closeDb();
  });

  return app;
}
