import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations");

describe("generated migrations", () => {
  it("contains at least one committed SQL migration defining the foundation tables", () => {
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBeGreaterThan(0);

    const sql = files.map((f) => readFileSync(path.join(migrationsDir, f), "utf-8")).join("\n");

    const expectedTables = [
      "users",
      "roles",
      "user_roles",
      "contacts",
      "groups",
      "group_members",
      "templates",
      "incidents",
      "incident_participants",
      "alerts",
      "alert_recipients",
      "chat_messages",
      "guest_invitations",
      "audit_logs",
    ];

    for (const table of expectedTables) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE[^;]*"${table}"`, "i"));
    }
  });
});
