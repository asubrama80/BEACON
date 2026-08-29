import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadEnv } from "../config/env.js";

describe("GET /health", () => {
  it("returns 200 with status, application, environment, and timestamp", async () => {
    const app = buildApp(loadEnv({ NODE_ENV: "test" }));

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      status: "ok",
      application: "beacon-backend",
      environment: "test",
    });
    expect(typeof body.timestamp).toBe("string");

    await app.close();
  });

  it("reports database health without crashing or leaking connection details when unconfigured", async () => {
    const originalUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    const app = buildApp(loadEnv({ NODE_ENV: "test" }));
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.database).toEqual({ connected: false });
    expect(JSON.stringify(body)).not.toMatch(/postgres:\/\//);

    await app.close();

    if (originalUrl !== undefined) {
      process.env.DATABASE_URL = originalUrl;
    }
  });
});
