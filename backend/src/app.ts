import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import formbody from "@fastify/formbody";
import { closeDb } from "@beacon/database";
import { loadEnv, type AppEnv } from "./config/env.js";
import { healthRoutes } from "./routes/health.js";
import { loadAuthConfig, loadMfaEncryptionKey, type AuthConfig } from "./modules/auth/config.js";
import { authRoutes } from "./modules/auth/routes.js";
import { AuthError } from "./modules/auth/errors.js";
import { usersRoutes } from "./modules/users/routes.js";
import { rbacRoutes } from "./modules/rbac/routes.js";
import { contactsRoutes } from "./modules/contacts/routes.js";
import { loadContactImportConfig, type ContactImportConfig } from "./modules/contactImport/config.js";
import { contactImportRoutes } from "./modules/contactImport/routes.js";
import { groupsRoutes } from "./modules/groups/routes.js";
import { templatesRoutes } from "./modules/templates/routes.js";
import { incidentsRoutes } from "./modules/incidents/routes.js";
import { alertsRoutes } from "./modules/alerts/routes.js";
import { loadAlertConfig, type AlertConfig } from "./modules/alerts/config.js";
import { loadNotificationConfig, type NotificationConfig } from "./modules/notifications/config.js";
import { getSmsProvider, getEmailProvider } from "./modules/notifications/providers/registry.js";
import { webhooksRoutes } from "./modules/notifications/webhooks/routes.js";

export interface BuildAppOptions {
  env?: AppEnv;
  authConfig?: AuthConfig;
  mfaEncryptionKey?: Buffer;
  contactImportConfig?: ContactImportConfig;
  alertConfig?: AlertConfig;
  notificationConfig?: NotificationConfig;
  /** Test-only seam for injecting a synthetic SNS signing certificate — never set in production. */
  sesFetchCert?: (url: string) => Promise<string>;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const env = options.env ?? loadEnv();
  const authConfig = options.authConfig ?? loadAuthConfig();
  const mfaEncryptionKey = options.mfaEncryptionKey ?? loadMfaEncryptionKey();
  const contactImportConfig = options.contactImportConfig ?? loadContactImportConfig();
  const alertConfig = options.alertConfig ?? loadAlertConfig();
  const notificationConfig = options.notificationConfig ?? loadNotificationConfig();
  // Fail fast at startup if an unsupported/misconfigured provider is selected — never wait until
  // an operator tries to dispatch a real Alert to discover it. See
  // claude/prompts/10-notification-providers.md, "Provider registry".
  getSmsProvider(notificationConfig);
  getEmailProvider(notificationConfig);

  const app = Fastify({ logger: env.nodeEnv !== "test" });

  app.register(cookie);
  // credentials:true is required so the browser sends/accepts the session and CSRF cookies
  // across the frontend/backend origin split in local dev (Vite on :5173, API on :4000).
  // origin is an explicit allow-list (never "*") because credentials:true forbids a wildcard.
  // methods must be listed explicitly — @fastify/cors defaults to GET,HEAD,POST only, which
  // silently blocks every real-browser PATCH/DELETE request (discovered live in Module 06 via
  // Groups' member-removal DELETE route; curl and Fastify's own `inject()` test harness don't
  // enforce CORS at all, so this had no way to surface until a real browser exercised it).
  app.register(cors, { origin: env.corsOrigin, credentials: true, methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"] });
  app.register(rateLimit, { global: false });
  // Bounded, in-memory-only multipart handling for Module 05's spreadsheet upload — the byte
  // limit here is the primary defense against an oversized upload consuming memory; the route
  // handler double-checks `file.truncated` since a file at exactly the limit streams without error.
  app.register(multipart, {
    limits: { fileSize: contactImportConfig.maxFileSizeBytes, files: 1, fields: 0 },
  });
  // Only needed for the Twilio status-callback webhook's application/x-www-form-urlencoded body.
  app.register(formbody);

  app.register((instance) => healthRoutes(instance, env));
  app.register((instance) => authRoutes(instance, { config: authConfig, mfaEncryptionKey }));
  app.register((instance) => usersRoutes(instance, { config: authConfig }));
  app.register((instance) => rbacRoutes(instance, { config: authConfig }));
  app.register((instance) => contactsRoutes(instance, { config: authConfig }));
  app.register((instance) => contactImportRoutes(instance, { config: authConfig, importConfig: contactImportConfig }));
  app.register((instance) => groupsRoutes(instance, { config: authConfig }));
  app.register((instance) => templatesRoutes(instance, { config: authConfig }));
  app.register((instance) => incidentsRoutes(instance, { config: authConfig }));
  app.register((instance) => alertsRoutes(instance, { config: authConfig, alertConfig, notificationConfig, nodeEnv: env.nodeEnv }));
  // Isolated from the rest of the application — no session auth/CSRF, provider-signature
  // authenticity instead. See claude/prompts/11-delivery-tracking.md, "Webhook routes".
  app.register((instance) => webhooksRoutes(instance, { notificationConfig, ...(options.sesFetchCert ? { sesFetchCert: options.sesFetchCert } : {}) }));

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
