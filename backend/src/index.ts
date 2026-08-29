import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();
const app = buildApp(env);

app
  .listen({ host: env.host, port: env.port })
  .catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
