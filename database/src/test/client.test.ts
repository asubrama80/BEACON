import { describe, expect, it } from "vitest";
import { loadDatabaseConfig, checkDatabaseHealth } from "../client.js";

describe("loadDatabaseConfig", () => {
  it("throws a clear error when DATABASE_URL is missing", () => {
    expect(() => loadDatabaseConfig({})).toThrow(/DATABASE_URL is required/);
  });

  it("returns the connection string when DATABASE_URL is set", () => {
    const config = loadDatabaseConfig({ DATABASE_URL: "postgres://user:pass@localhost:5432/db" });
    expect(config.connectionString).toBe("postgres://user:pass@localhost:5432/db");
  });
});

describe("checkDatabaseHealth", () => {
  it("reports connected: false without throwing when the database is unreachable", async () => {
    const originalUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://user:pass@127.0.0.1:59999/beacon_unreachable";

    const health = await checkDatabaseHealth();

    expect(health).toEqual({ connected: false });
    expect(JSON.stringify(health)).not.toMatch(/pass|127\.0\.0\.1/);

    if (originalUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalUrl;
    }
  }, 10000);
});
