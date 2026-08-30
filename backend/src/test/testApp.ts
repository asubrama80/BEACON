import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { loadAuthConfig } from "../modules/auth/config.js";
import { loadContactImportConfig } from "../modules/contactImport/config.js";
import { loadAlertConfig } from "../modules/alerts/config.js";
import { loadNotificationConfig } from "../modules/notifications/config.js";

/** A fixed-per-process key so encrypted values created in one test are readable within the same run. */
export const TEST_MFA_ENCRYPTION_KEY = randomBytes(32);

export function buildTestApp(
  envOverrides: NodeJS.ProcessEnv = {},
  options: { sesFetchCert?: (url: string) => Promise<string> } = {},
): FastifyInstance {
  const source = { NODE_ENV: "test", ...envOverrides };
  return buildApp({
    env: loadEnv(source),
    authConfig: loadAuthConfig(source),
    mfaEncryptionKey: TEST_MFA_ENCRYPTION_KEY,
    contactImportConfig: loadContactImportConfig(source),
    // Previously omitted — buildApp() would otherwise fall back to loading these from the real
    // process.env, silently ignoring any envOverrides a test passed in (discovered via Module 11's
    // Twilio webhook tests, which need TWILIO_*/PUBLIC_BASE_URL overrides to actually take effect).
    alertConfig: loadAlertConfig(source),
    notificationConfig: loadNotificationConfig(source),
    ...(options.sesFetchCert ? { sesFetchCert: options.sesFetchCert } : {}),
  });
}
