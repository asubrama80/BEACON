import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import { contacts } from "../schema/contacts.js";
import { users } from "../schema/users.js";
import { incidentParticipants } from "../schema/incidentParticipants.js";
import { alertRecipients } from "../schema/alertRecipients.js";
import { roles, SYSTEM_ROLE_CODES } from "../schema/roles.js";
import { auditLogs } from "../schema/auditLogs.js";

describe("contacts schema", () => {
  it("has no user_id column — contacts stay independent of application users", () => {
    const config = getTableConfig(contacts);
    expect(config.columns.some((col) => col.name === "user_id")).toBe(false);
  });
});

describe("users schema", () => {
  it("has a uuid primary key and unique email", () => {
    const config = getTableConfig(users);
    const idColumn = config.columns.find((col) => col.name === "id");
    expect(idColumn?.primary).toBe(true);
    expect(config.indexes.some((idx) => idx.config.name === "users_email_idx")).toBe(true);
  });
});

describe("incident_participants schema", () => {
  it("has a reference-integrity check constraint tying participant_type to the matching reference", () => {
    const config = getTableConfig(incidentParticipants);
    expect(
      config.checks.some((c) => c.name === "incident_participants_reference_check"),
    ).toBe(true);
  });

  it("allows userId, contactId, and guestInvitationId to each be independently nullable", () => {
    const config = getTableConfig(incidentParticipants);
    const nullableRefs = ["user_id", "contact_id", "guest_invitation_id"];
    for (const columnName of nullableRefs) {
      const column = config.columns.find((col) => col.name === columnName);
      expect(column?.notNull).toBe(false);
    }
  });
});

describe("alert_recipients schema", () => {
  it("does not require contact_id — external/manual recipients are supported", () => {
    const config = getTableConfig(alertRecipients);
    const contactIdColumn = config.columns.find((col) => col.name === "contact_id");
    expect(contactIdColumn?.notNull).toBe(false);
    expect(
      config.checks.some((c) => c.name === "alert_recipients_target_check"),
    ).toBe(true);
  });
});

describe("audit_logs schema", () => {
  it("is append-only — no updated_at or deleted_at column", () => {
    const config = getTableConfig(auditLogs);
    expect(config.columns.some((col) => col.name === "updated_at")).toBe(false);
    expect(config.columns.some((col) => col.name === "deleted_at")).toBe(false);
  });
});

describe("roles seed set", () => {
  it("defines exactly the five required system role codes with no duplicates", () => {
    expect(SYSTEM_ROLE_CODES).toHaveLength(5);
    expect(new Set(SYSTEM_ROLE_CODES).size).toBe(5);
    expect([...SYSTEM_ROLE_CODES].sort()).toEqual(
      ["ADMIN", "AUDITOR", "COMMUNICATION_MANAGER", "INCIDENT_COMMANDER", "RESPONDER"].sort(),
    );
  });

  it("has a unique constraint on role code", () => {
    const config = getTableConfig(roles);
    const codeColumn = config.columns.find((col) => col.name === "code");
    expect(codeColumn?.isUnique).toBe(true);
  });
});
