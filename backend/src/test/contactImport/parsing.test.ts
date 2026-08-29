import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { detectFileType, parseSpreadsheet } from "../../modules/contactImport/parsing.js";
import { loadContactImportConfig } from "../../modules/contactImport/config.js";

const config = loadContactImportConfig({});

async function buildXlsxBuffer(rows: (string | number)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  rows.forEach((row) => sheet.addRow(row));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

describe("detectFileType", () => {
  it("detects csv by extension", () => {
    expect(detectFileType("contacts.csv")).toBe("csv");
    expect(detectFileType("Contacts.CSV")).toBe("csv");
  });

  it("detects xlsx by extension", () => {
    expect(detectFileType("contacts.xlsx")).toBe("xlsx");
  });

  it("rejects unsupported extensions, including legacy .xls", () => {
    expect(() => detectFileType("contacts.xls")).toThrow();
    expect(() => detectFileType("contacts.txt")).toThrow();
    expect(() => detectFileType("contacts")).toThrow();
  });
});

describe("parseSpreadsheet (csv)", () => {
  it("parses a valid CSV into headers and rows", async () => {
    const csv = "First Name,Last Name,Email\nJohn,Doe,john@example.invalid\nJane,Smith,jane@example.invalid\n";
    const parsed = await parseSpreadsheet(Buffer.from(csv), "csv", config);
    expect(parsed.headers).toEqual(["First Name", "Last Name", "Email"]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual(["John", "Doe", "john@example.invalid"]);
  });

  it("trims whitespace from headers and cells", async () => {
    const csv = " First Name , Last Name \n John , Doe \n";
    const parsed = await parseSpreadsheet(Buffer.from(csv), "csv", config);
    expect(parsed.headers).toEqual(["First Name", "Last Name"]);
    expect(parsed.rows[0]).toEqual(["John", "Doe"]);
  });

  it("rejects a file with no data rows (header-only)", async () => {
    const csv = "First Name,Last Name\n";
    await expect(parseSpreadsheet(Buffer.from(csv), "csv", config)).rejects.toThrow(/no data rows/i);
  });

  it("rejects a completely empty file", async () => {
    await expect(parseSpreadsheet(Buffer.from(""), "csv", config)).rejects.toThrow(/no header row/i);
  });

  it("rejects duplicate headers", async () => {
    const csv = "Email,Email\na@example.invalid,b@example.invalid\n";
    await expect(parseSpreadsheet(Buffer.from(csv), "csv", config)).rejects.toThrow(/duplicate column header/i);
  });

  it("rejects a file exceeding the configured row limit", async () => {
    const smallConfig = loadContactImportConfig({ CONTACT_IMPORT_MAX_ROWS: "2" });
    const csv = "Name\nA\nB\nC\n";
    await expect(parseSpreadsheet(Buffer.from(csv), "csv", smallConfig)).rejects.toThrow(/too many rows/i);
  });

  it("rejects a file exceeding the configured column limit", async () => {
    const smallConfig = loadContactImportConfig({ CONTACT_IMPORT_MAX_COLUMNS: "2" });
    const csv = "A,B,C\n1,2,3\n";
    await expect(parseSpreadsheet(Buffer.from(csv), "csv", smallConfig)).rejects.toThrow(/too many columns/i);
  });

  it("rejects malformed CSV content", async () => {
    const malformed = '"unterminated quote,broken\n';
    await expect(parseSpreadsheet(Buffer.from(malformed), "csv", config)).rejects.toThrow(/unable to parse/i);
  });
});

describe("parseSpreadsheet (xlsx)", () => {
  it("parses a valid XLSX workbook into headers and rows", async () => {
    const buffer = await buildXlsxBuffer([
      ["First Name", "Last Name", "Email"],
      ["John", "Doe", "john@example.invalid"],
      ["Jane", "Smith", "jane@example.invalid"],
    ]);
    const parsed = await parseSpreadsheet(buffer, "xlsx", config);
    expect(parsed.headers).toEqual(["First Name", "Last Name", "Email"]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual(["John", "Doe", "john@example.invalid"]);
  });

  it("reads a formula cell's cached result, never the formula string", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["Name", "Computed"]);
    const row = sheet.addRow(["Formula Row"]);
    row.getCell(2).value = { formula: "1+1", result: 2 };
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const parsed = await parseSpreadsheet(buffer, "xlsx", config);
    expect(parsed.rows[0]).toEqual(["Formula Row", "2"]);
    expect(JSON.stringify(parsed.rows)).not.toContain("1+1");
  });

  it("treats a formula cell that errored in the source file as empty, not a crash", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.addRow(["Name", "Computed"]);
    const row = sheet.addRow(["Formula Row"]);
    row.getCell(2).value = { formula: "1/0", result: { error: "#DIV/0!" } };
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const parsed = await parseSpreadsheet(buffer, "xlsx", config);
    expect(parsed.rows[0]).toEqual(["Formula Row", ""]);
  });

  it("rejects malformed XLSX content", async () => {
    await expect(parseSpreadsheet(Buffer.from("not a real xlsx file"), "xlsx", config)).rejects.toThrow(
      /unable to parse/i,
    );
  });

  it("rejects a workbook with no data rows", async () => {
    const buffer = await buildXlsxBuffer([["Name", "Email"]]);
    await expect(parseSpreadsheet(buffer, "xlsx", config)).rejects.toThrow(/no data rows/i);
  });
});
