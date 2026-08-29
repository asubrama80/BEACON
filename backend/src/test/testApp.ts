import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";
import { loadAuthConfig } from "../modules/auth/config.js";
import { loadContactImportConfig } from "../modules/contactImport/config.js";

/** A fixed-per-process key so encrypted values created in one test are readable within the same run. */
export const TEST_MFA_ENCRYPTION_KEY = randomBytes(32);

export function buildTestApp(envOverrides: NodeJS.ProcessEnv = {}): FastifyInstance {
  const source = { NODE_ENV: "test", ...envOverrides };
  return buildApp({
    env: loadEnv(source),
    authConfig: loadAuthConfig(source),
    mfaEncryptionKey: TEST_MFA_ENCRYPTION_KEY,
    contactImportConfig: loadContactImportConfig(source),
  });
}
