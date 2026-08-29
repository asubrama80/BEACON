import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Several integration tests share one live database and reason about global state (e.g.
    // "how many active administrators exist right now" for the last-admin safeguard) — running
    // test files in parallel workers would make that state non-deterministic across files.
    fileParallelism: false,
  },
});
