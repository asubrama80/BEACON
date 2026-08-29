import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { loadDatabaseConfig } from "@beacon/database";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

// Repository root .env, two levels above both backend/src and backend/dist.
loadDotenv({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });

try {
  loadDatabaseConfig();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid database configuration.");
  process.exit(1);
}

const env = loadEnv();
const app = buildApp(env);

app
  .listen({ host: env.host, port: env.port })
  .catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
