/**
 * Integration tests for the Module 05 contact-import routes, run end-to-end against a live
 * PostgreSQL database. Skipped when DATABASE_URL isn't reachable, same convention as Modules
 * 02–04. Runs sequentially with other backend test files (`fileParallelism: false`).
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  getDb,
  users,
  roles,
  userRoles,
  contacts,
  auditLogs,
  contactImportBatches,
  contactImportRows,
  type Database,
} from "@beacon/database";
import { buildTestApp } from "../testApp.js";
import { hashPassword } from "../../modules/auth/password.js";
import { loadAuthConfig } from "../../modules/auth/config.js";

loadDotenv({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
});

async function buildXlsxBuffer(rows: (string | number)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function csvUploadForm(fileName: string, content: string): FormData {
  const form = new FormData();
  form.set("file", new Blob([content], { type: "text/csv" }), fileName);
  return form;
}

function xlsxUploadForm(fileName: string, buffer: Buffer): FormData {
  const form = new FormData();
  form.set(
    "file",
    new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
    fileName,
  );
  return form;
}

describe.skipIf(!process.env.DATABASE_URL)("contact import routes (live database)", () => {
  const config = loadAuthConfig({ LOGIN_RATE_LIMIT_MAX: "500" });
  const app = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500" });
  const db: Database = getDb();

  const testPassword = "Correct-Horse-Battery-C05";
  const createdUserIds: string[] = [];
  const createdContactRefPrefix = `IMP05-${randomUUID().slice(0, 8)}`;
  let contactCounter = 0;

  async function roleId(code: string): Promise<string> {
    const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!row) throw new Error(`role ${code} not seeded`);
    return row.id;
  }

  async function createActor(roleCode: string): Promise<{ id: string; token: string; csrf: string }> {
    const email = `test-import-${roleCode.toLowerCase()}-${randomUUID()}@example.invalid`;
    const passwordHash = await hashPassword(testPassword, config);
    const [row] = await db
      .insert(users)
      .values({ email, displayName: `Import Test ${roleCode}`, passwordHash })
      .returning({ id: users.id });
    createdUserIds.push(row!.id);
    await db.insert(userRoles).values({ userId: row!.id, roleId: await roleId(roleCode) });

    const response = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: testPassword } });
    if (response.statusCode !== 200) {
      throw new Error(`login failed for ${roleCode}: ${response.statusCode} ${response.body}`);
    }
    return {
      id: row!.id,
      token: response.cookies.find((c) => c.name === config.sessionCookieName)!.value,
      csrf: response.cookies.find((c) => c.name === config.csrfCookieName)!.value,
    };
  }

  function authHeaders(session: { token: string; csrf: string }) {
    return {
      cookies: { [config.sessionCookieName]: session.token, [config.csrfCookieName]: session.csrf },
      headers: { "x-csrf-token": session.csrf },
    };
  }

  function nextRef(): string {
    contactCounter += 1;
    return `${createdContactRefPrefix}-${contactCounter}`;
  }

  async function upload(session: { token: string; csrf: string }, form: FormData) {
    return app.inject({ method: "POST", url: "/contacts/import/upload", payload: form, ...authHeaders(session) });
  }

  async function preview(session: { token: string; csrf: string }, batchId: string, mapping: Record<string, string>) {
    return app.inject({
      method: "POST",
      url: `/contacts/import/${batchId}/preview`,
      payload: { mapping },
      ...authHeaders(session),
    });
  }

  async function confirm(
    session: { token: string; csrf: string },
    batchId: string,
    decisions: { rowId: string; selected: boolean; confirmDuplicate?: boolean }[],
  ) {
    return app.inject({
      method: "POST",
      url: `/contacts/import/${batchId}/confirm`,
      payload: { decisions },
      ...authHeaders(session),
    });
  }

  let admin: { id: string; token: string; csrf: string };
  let commManager: { id: string; token: string; csrf: string };
  let auditor: { id: string; token: string; csrf: string };
  let incidentCommander: { id: string; token: string; csrf: string };
  let responder: { id: string; token: string; csrf: string };

  beforeAll(async () => {
    admin = await createActor("ADMIN");
    commManager = await createActor("COMMUNICATION_MANAGER");
    auditor = await createActor("AUDITOR");
    incidentCommander = await createActor("INCIDENT_COMMANDER");
    responder = await createActor("RESPONDER");
  });

  afterAll(async () => {
    const importedContacts = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(like(contacts.referenceId, `${createdContactRefPrefix}%`));
    for (const c of importedContacts) {
      await db.delete(auditLogs).where(eq(auditLogs.resourceId, c.id));
      await db.delete(contacts).where(eq(contacts.id, c.id));
    }
    for (const id of createdUserIds) {
      const batches = await db.select({ id: contactImportBatches.id }).from(contactImportBatches).where(eq(contactImportBatches.createdBy, id));
      for (const b of batches) {
        await db.delete(auditLogs).where(eq(auditLogs.resourceId, b.id));
        await db.delete(contactImportRows).where(eq(contactImportRows.batchId, b.id));
        await db.delete(contactImportBatches).where(eq(contactImportBatches.id, b.id));
      }
      await db.delete(auditLogs).where(eq(auditLogs.actorId, id));
      await db.delete(users).where(eq(users.id, id));
    }
    await app.close();
  });

  describe("authentication and authorization", () => {
    it("upload requires authentication", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/contacts/import/upload",
        payload: csvUploadForm("x.csv", "First Name,Last Name\nA,B\n"),
      });
      expect(response.statusCode).toBe(401);
    });

    it("RESPONDER is denied import access", async () => {
      const response = await upload(responder, csvUploadForm("x.csv", "First Name,Last Name\nA,B\n"));
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("not_authorized");
    });

    it("AUDITOR is denied import access", async () => {
      const response = await upload(auditor, csvUploadForm("x.csv", "First Name,Last Name\nA,B\n"));
      expect(response.statusCode).toBe(403);
    });

    it("INCIDENT_COMMANDER is denied import access", async () => {
      const response = await upload(incidentCommander, csvUploadForm("x.csv", "First Name,Last Name\nA,B\n"));
      expect(response.statusCode).toBe(403);
    });

    it("COMMUNICATION_MANAGER can upload and preview", async () => {
      const ref = nextRef();
      const uploaded = await upload(
        commManager,
        csvUploadForm("cm.csv", `First Name,Last Name,Employee ID\nComm,Manager,${ref}\n`),
      );
      expect(uploaded.statusCode).toBe(201);
      const batchId = uploaded.json().batch.id as string;

      const previewed = await preview(commManager, batchId, {
        "First Name": "firstName",
        "Last Name": "lastName",
        "Employee ID": "referenceId",
      });
      expect(previewed.statusCode).toBe(200);
      expect(previewed.json().rows[0].status).toBe("valid");
    });
  });

  describe("upload and parsing", () => {
    it("upload alone never creates a Contact", async () => {
      const ref = nextRef();
      const before = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.referenceId, ref));
      expect(before).toHaveLength(0);

      await upload(admin, csvUploadForm("nocreate.csv", `First Name,Last Name,Employee ID\nNo,Create,${ref}\n`));

      const after = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.referenceId, ref));
      expect(after).toHaveLength(0);
    });

    it("returns detected headers, sample rows, and a suggested mapping", async () => {
      const response = await upload(
        admin,
        csvUploadForm("headers.csv", "First Name,Last Name,Email,Mobile\nA,B,a@example.invalid,212-456-7890\n"),
      );
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.batch.headers).toEqual(["First Name", "Last Name", "Email", "Mobile"]);
      expect(body.sampleRows).toHaveLength(1);
      expect(body.suggestedMapping).toEqual([
        { header: "First Name", suggested: "firstName" },
        { header: "Last Name", suggested: "lastName" },
        { header: "Email", suggested: "email" },
        { header: "Mobile", suggested: "mobilePhone" },
      ]);
    });

    it("rejects an unsupported file extension", async () => {
      const form = new FormData();
      form.set("file", new Blob(["hello"], { type: "text/plain" }), "notes.txt");
      const response = await upload(admin, form);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("import_file_invalid");
    });

    it("rejects an oversized file", async () => {
      const smallApp = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500", CONTACT_IMPORT_MAX_FILE_SIZE_BYTES: "50" });
      const loginResp = await smallApp.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: (await db.select({ email: users.email }).from(users).where(eq(users.id, admin.id)))[0]!.email, password: testPassword },
      });
      const session = {
        token: loginResp.cookies.find((c) => c.name === config.sessionCookieName)!.value,
        csrf: loginResp.cookies.find((c) => c.name === config.csrfCookieName)!.value,
      };
      const bigCsv = "First Name,Last Name\n" + "A,B\n".repeat(50);
      const response = await smallApp.inject({
        method: "POST",
        url: "/contacts/import/upload",
        payload: csvUploadForm("big.csv", bigCsv),
        cookies: { [config.sessionCookieName]: session.token, [config.csrfCookieName]: session.csrf },
        headers: { "x-csrf-token": session.csrf },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("import_file_invalid");
      // Deliberately not calling smallApp.close(): it would tear down the shared getDb() pool
      // that the outer `app` and `db` in this file also depend on.
    });

    it("rejects an empty file", async () => {
      const response = await upload(admin, csvUploadForm("empty.csv", ""));
      expect(response.statusCode).toBe(400);
    });

    it("rejects a header-only file", async () => {
      const response = await upload(admin, csvUploadForm("headeronly.csv", "First Name,Last Name\n"));
      expect(response.statusCode).toBe(400);
    });

    it("uploads and previews an XLSX workbook", async () => {
      const ref = nextRef();
      const buffer = await buildXlsxBuffer([
        ["First Name", "Last Name", "Employee ID"],
        ["Xlsx", "Row", ref],
      ]);
      const uploaded = await upload(admin, xlsxUploadForm("contacts.xlsx", buffer));
      expect(uploaded.statusCode).toBe(201);
      expect(uploaded.json().batch.fileType).toBe("xlsx");

      const batchId = uploaded.json().batch.id as string;
      const previewed = await preview(admin, batchId, {
        "First Name": "firstName",
        "Last Name": "lastName",
        "Employee ID": "referenceId",
      });
      expect(previewed.statusCode).toBe(200);
      expect(previewed.json().rows[0].status).toBe("valid");
    });
  });

  describe("mapping", () => {
    it("rejects a mapping destination outside the Contact-field allowlist at the schema layer", async () => {
      const uploaded = await upload(admin, csvUploadForm("m.csv", "First Name,Last Name\nA,B\n"));
      const batchId = uploaded.json().batch.id as string;
      const response = await preview(admin, batchId, { "First Name": "id" });
      expect(response.statusCode).toBe(400);
    });

    it("rejects a mapping missing a required destination field", async () => {
      const uploaded = await upload(admin, csvUploadForm("m2.csv", "First Name,Last Name\nA,B\n"));
      const batchId = uploaded.json().batch.id as string;
      const response = await preview(admin, batchId, { "First Name": "firstName" });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("import_mapping_invalid");
    });

    it("rejects two columns mapped to the same destination", async () => {
      const uploaded = await upload(admin, csvUploadForm("m3.csv", "A,B\nx,y\n"));
      const batchId = uploaded.json().batch.id as string;
      const response = await preview(admin, batchId, { A: "firstName", B: "firstName" });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("preview: validation, normalization, and duplicates", () => {
    it("produces correct row statuses and never creates a Contact", async () => {
      const refValid = nextRef();
      const csv =
        "First Name,Last Name,Employee ID,Email,Mobile\n" +
        `Valid,Row,${refValid},valid-${refValid}@example.invalid,212-456-7890\n` +
        `,Missing,${nextRef()},x@example.invalid,\n`;

      const beforeCount = await db.select({ id: contacts.id }).from(contacts);

      const uploaded = await upload(admin, csvUploadForm("preview.csv", csv));
      const batchId = uploaded.json().batch.id as string;
      const previewed = await preview(admin, batchId, {
        "First Name": "firstName",
        "Last Name": "lastName",
        "Employee ID": "referenceId",
        Email: "email",
        Mobile: "mobilePhone",
      });

      expect(previewed.statusCode).toBe(200);
      const body = previewed.json();
      expect(body.batch.summary.total).toBe(2);
      expect(body.batch.summary.valid).toBe(1);
      expect(body.batch.summary.invalid).toBe(1);
      expect(body.rows.find((r: { status: string }) => r.status === "valid").mobilePhone).toBe("+12124567890");
      expect(body.rows.find((r: { status: string }) => r.status === "invalid").reasons[0]).toMatch(/first name/i);

      const afterCount = await db.select({ id: contacts.id }).from(contacts);
      expect(afterCount.length).toBe(beforeCount.length);
    });

    it("flags a database duplicate as possible_duplicate", async () => {
      const dupEmail = `dbdup-${randomUUID()}@example.invalid`;
      const existingRef = nextRef();
      await app.inject({
        method: "POST",
        url: "/contacts",
        ...authHeaders(admin),
        payload: { firstName: "Existing", lastName: "Contact", referenceId: existingRef, email: dupEmail },
      });

      const newRef = nextRef();
      const uploaded = await upload(
        admin,
        csvUploadForm("dbdup.csv", `First Name,Last Name,Employee ID,Email\nNew,Person,${newRef},${dupEmail}\n`),
      );
      const batchId = uploaded.json().batch.id as string;
      const previewed = await preview(admin, batchId, {
        "First Name": "firstName",
        "Last Name": "lastName",
        "Employee ID": "referenceId",
        Email: "email",
      });
      expect(previewed.json().rows[0].status).toBe("possible_duplicate");
      expect(previewed.json().rows[0].duplicateMatches[0].matchedOn).toContain("email");
      expect(previewed.json().batch.summary.possibleDuplicate).toBe(1);
    });

    it("flags in-file duplicate email (case-insensitive), keeping the first occurrence distinct", async () => {
      const email = `infile-${randomUUID()}@example.invalid`;
      const ref1 = nextRef();
      const ref2 = nextRef();
      const csv =
        "First Name,Last Name,Employee ID,Email\n" +
        `First,Occurrence,${ref1},${email}\n` +
        `Second,Occurrence,${ref2},${email.toUpperCase()}\n`;

      const uploaded = await upload(admin, csvUploadForm("infile.csv", csv));
      const batchId = uploaded.json().batch.id as string;
      const previewed = await preview(admin, batchId, {
        "First Name": "firstName",
        "Last Name": "lastName",
        "Employee ID": "referenceId",
        Email: "email",
      });

      const rows = previewed.json().rows as { rowIndex: number; status: string }[];
      const row1 = rows.find((r) => r.rowIndex === 1)!;
      const row2 = rows.find((r) => r.rowIndex === 2)!;
      expect(row1.status).toBe("valid");
      expect(row2.status).toBe("duplicate_in_file");
      expect(previewed.json().batch.summary.duplicateInFile).toBe(1);
    });

    it("flags in-file duplicate phone", async () => {
      const phone = "212-333-9999";
      const ref1 = nextRef();
      const ref2 = nextRef();
      const csv =
        "First Name,Last Name,Employee ID,Mobile\n" +
        `First,Occurrence,${ref1},${phone}\n` +
        `Second,Occurrence,${ref2},${phone}\n`;

      const uploaded = await upload(admin, csvUploadForm("infilephone.csv", csv));
      const batchId = uploaded.json().batch.id as string;
      const previewed = await preview(admin, batchId, {
        "First Name": "firstName",
        "Last Name": "lastName",
        "Employee ID": "referenceId",
        Mobile: "mobilePhone",
      });
      const rows = previewed.json().rows as { rowIndex: number; status: string }[];
      expect(rows.find((r) => r.rowIndex === 2)!.status).toBe("duplicate_in_file");
    });
  });

  describe("confirmation", () => {
    it("imports selected valid rows, skips invalid and unapproved duplicate rows", async () => {
      const validRef = nextRef();
      const invalidRef = nextRef();
      const dupEmail = `confirm-dup-${randomUUID()}@example.invalid`;
      const existingRef = nextRef();
      await app.inject({
        method: "POST",
        url: "/contacts",
        ...authHeaders(admin),
        payload: { firstName: "Existing", lastName: "One", referenceId: existingRef, email: dupEmail },
      });

      const dupRef = nextRef();
      const csv =
        "First Name,Last Name,Employee ID,Email\n" +
        `Valid,Person,${validRef},valid-${validRef}@example.invalid\n` +
        `,Invalid,${invalidRef},bad@example.invalid\n` +
        `Dup,Person,${dupRef},${dupEmail}\n`;

      const uploaded = await upload(admin, csvUploadForm("confirm.csv", csv));
      const batchId = uploaded.json().batch.id as string;
      const previewed = await preview(admin, batchId, {
        "First Name": "firstName",
        "Last Name": "lastName",
        "Employee ID": "referenceId",
        Email: "email",
      });
      const rows = previewed.json().rows as { id: string; rowIndex: number; status: string; selected: boolean }[];

      const validRow = rows.find((r) => r.rowIndex === 1)!;
      const invalidRow = rows.find((r) => r.rowIndex === 2)!;
      const dupRow = rows.find((r) => r.rowIndex === 3)!;
      expect(validRow.selected).toBe(true);
      expect(invalidRow.selected).toBe(false);
      expect(dupRow.selected).toBe(false);

      // Attempt to smuggle the invalid row through by selecting it anyway — the server must
      // ignore the client's selected:true and never import it.
      const confirmed = await confirm(admin, batchId, [
        { rowId: validRow.id, selected: true },
        { rowId: invalidRow.id, selected: true },
        { rowId: dupRow.id, selected: false },
      ]);

      expect(confirmed.statusCode).toBe(200);
      const result = confirmed.json();
      expect(result.summary.imported).toBe(1);
      expect(result.summary.skipped).toBe(2);
      expect(result.results.find((r: { rowIndex: number }) => r.rowIndex === 1).importResult).toBe("imported");
      expect(result.results.find((r: { rowIndex: number }) => r.rowIndex === 2).importResult).toBe("skipped");
      expect(result.results.find((r: { rowIndex: number }) => r.rowIndex === 3).importResult).toBe("skipped");

      const invalidCreated = await db.select().from(contacts).where(eq(contacts.referenceId, invalidRef));
      expect(invalidCreated).toHaveLength(0);
      const dupCreated = await db.select().from(contacts).where(eq(contacts.referenceId, dupRef));
      expect(dupCreated).toHaveLength(0);
      const validCreated = await db.select().from(contacts).where(eq(contacts.referenceId, validRef));
      expect(validCreated).toHaveLength(1);
    });

    it("explicitly approving a duplicate row creates a genuinely separate Contact", async () => {
      const dupEmail = `approve-dup-${randomUUID()}@example.invalid`;
      const existingRef = nextRef();
      await app.inject({
        method: "POST",
        url: "/contacts",
        ...authHeaders(admin),
        payload: { firstName: "Existing", lastName: "Two", referenceId: existingRef, email: dupEmail },
      });

      const dupRef = nextRef();
      const uploaded = await upload(
        admin,
        csvUploadForm("approvedup.csv", `First Name,Last Name,Employee ID,Email\nDup,Approved,${dupRef},${dupEmail}\n`),
      );
      const batchId = uploaded.json().batch.id as string;
      const previewed = await preview(admin, batchId, {
        "First Name": "firstName",
        "Last Name": "lastName",
        "Employee ID": "referenceId",
        Email: "email",
      });
      const row = previewed.json().rows[0] as { id: string };

      const confirmed = await confirm(admin, batchId, [{ rowId: row.id, selected: true, confirmDuplicate: true }]);
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.json().summary.imported).toBe(1);

      const rows = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.email, dupEmail));
      expect(rows).toHaveLength(2);
    });

    it("cannot confirm the same batch twice", async () => {
      const ref = nextRef();
      const uploaded = await upload(
        admin,
        csvUploadForm("twice.csv", `First Name,Last Name,Employee ID\nOnce,Only,${ref}\n`),
      );
      const batchId = uploaded.json().batch.id as string;
      const previewed = await preview(admin, batchId, { "First Name": "firstName", "Last Name": "lastName", "Employee ID": "referenceId" });
      const row = previewed.json().rows[0] as { id: string };

      const first = await confirm(admin, batchId, [{ rowId: row.id, selected: true }]);
      expect(first.statusCode).toBe(200);

      const second = await confirm(admin, batchId, [{ rowId: row.id, selected: true }]);
      expect(second.statusCode).toBe(409);
      expect(second.json().error).toBe("import_batch_not_previewable");

      // The second (rejected) confirm attempt must not have created a duplicate contact.
      const created = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.referenceId, ref));
      expect(created).toHaveLength(1);
    });

    it("an operator cannot preview or confirm another operator's batch", async () => {
      const uploaded = await upload(admin, csvUploadForm("owned.csv", "First Name,Last Name\nOwned,Batch\n"));
      const batchId = uploaded.json().batch.id as string;

      const foreignPreview = await preview(commManager, batchId, { "First Name": "firstName", "Last Name": "lastName" });
      expect(foreignPreview.statusCode).toBe(403);

      const foreignGet = await app.inject({
        method: "GET",
        url: `/contacts/import/${batchId}`,
        ...authHeaders(commManager),
      });
      expect(foreignGet.statusCode).toBe(403);

      const foreignConfirm = await confirm(commManager, batchId, []);
      expect(foreignConfirm.statusCode).toBe(403);
    });

    it("rejects confirming a batch that has not been previewed yet", async () => {
      const uploaded = await upload(admin, csvUploadForm("nopreview.csv", "First Name,Last Name\nNo,Preview\n"));
      const batchId = uploaded.json().batch.id as string;
      const response = await confirm(admin, batchId, []);
      expect(response.statusCode).toBe(409);
    });

    it("rejects preview/confirm on an expired batch", async () => {
      const shortTtlApp = buildTestApp({ LOGIN_RATE_LIMIT_MAX: "500", CONTACT_IMPORT_BATCH_TTL_MINUTES: "0" });
      const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, admin.id));
      const loginResp = await shortTtlApp.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: row!.email, password: testPassword },
      });
      const session = {
        token: loginResp.cookies.find((c) => c.name === config.sessionCookieName)!.value,
        csrf: loginResp.cookies.find((c) => c.name === config.csrfCookieName)!.value,
      };
      const headers = {
        cookies: { [config.sessionCookieName]: session.token, [config.csrfCookieName]: session.csrf },
        headers: { "x-csrf-token": session.csrf },
      };
      const uploaded = await shortTtlApp.inject({
        method: "POST",
        url: "/contacts/import/upload",
        payload: csvUploadForm("expired.csv", "First Name,Last Name\nExpired,Batch\n"),
        ...headers,
      });
      const batchId = uploaded.json().batch.id as string;

      await new Promise((resolve) => setTimeout(resolve, 50));

      const response = await shortTtlApp.inject({
        method: "POST",
        url: `/contacts/import/${batchId}/preview`,
        payload: { mapping: { "First Name": "firstName", "Last Name": "lastName" } },
        ...headers,
      });
      expect(response.statusCode).toBe(410);
      expect(response.json().error).toBe("import_batch_expired");
      // Deliberately not calling shortTtlApp.close(): see the note in "rejects an oversized file".
    });
  });

  describe("audit trail and privacy", () => {
    it("records CONTACT_IMPORT_PREVIEWED and CONTACT_IMPORT_COMPLETED without PII in metadata", async () => {
      const ref = nextRef();
      const email = `audit-${randomUUID()}@example.invalid`;
      const uploaded = await upload(
        admin,
        csvUploadForm("audit.csv", `First Name,Last Name,Employee ID,Email\nAudit,Row,${ref},${email}\n`),
      );
      const batchId = uploaded.json().batch.id as string;
      const previewed = await preview(admin, batchId, {
        "First Name": "firstName",
        "Last Name": "lastName",
        "Employee ID": "referenceId",
        Email: "email",
      });
      const row = previewed.json().rows[0] as { id: string };
      await confirm(admin, batchId, [{ rowId: row.id, selected: true }]);

      const events = await db
        .select({ eventType: auditLogs.eventType, metadata: auditLogs.metadata })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, batchId));

      const eventTypes = events.map((e) => e.eventType);
      expect(eventTypes).toContain("CONTACT_IMPORT_PREVIEWED");
      expect(eventTypes).toContain("CONTACT_IMPORT_COMPLETED");

      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(email);
      expect(serialized).not.toContain("Audit");
    });

    it("purges raw rows and row-level PII from the database after a batch completes", async () => {
      const ref = nextRef();
      const email = `purge-${randomUUID()}@example.invalid`;
      const uploaded = await upload(
        admin,
        csvUploadForm("purge.csv", `First Name,Last Name,Employee ID,Email\nPurge,Me,${ref},${email}\n`),
      );
      const batchId = uploaded.json().batch.id as string;
      const previewed = await preview(admin, batchId, {
        "First Name": "firstName",
        "Last Name": "lastName",
        "Employee ID": "referenceId",
        Email: "email",
      });
      const row = previewed.json().rows[0] as { id: string };
      await confirm(admin, batchId, [{ rowId: row.id, selected: true }]);

      const [batchRow] = await db.select().from(contactImportBatches).where(eq(contactImportBatches.id, batchId));
      expect(batchRow!.rawRows).toBeNull();

      const [storedRow] = await db.select().from(contactImportRows).where(eq(contactImportRows.id, row.id));
      expect(storedRow!.email).toBeNull();
      expect(storedRow!.firstName).toBeNull();
    });
  });
});
