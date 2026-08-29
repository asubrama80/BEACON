import { describe, expect, it } from "vitest";
import { suggestMapping, validateMapping } from "../../modules/contactImport/mapping.js";

describe("suggestMapping", () => {
  it("suggests common header variants case/spacing-insensitively", () => {
    const suggestions = suggestMapping([
      "First Name",
      "last_name",
      "LastName",
      "Email Address",
      "Cell Phone",
      "Dept",
    ]);
    expect(suggestions).toEqual([
      { header: "First Name", suggested: "firstName" },
      { header: "last_name", suggested: "lastName" },
      { header: "LastName", suggested: "lastName" },
      { header: "Email Address", suggested: "email" },
      { header: "Cell Phone", suggested: "mobilePhone" },
      { header: "Dept", suggested: "department" },
    ]);
  });

  it("suggests nothing for an ambiguous or unrecognized header", () => {
    const suggestions = suggestMapping(["Notes", "Favorite Color"]);
    expect(suggestions.every((s) => s.suggested === null)).toBe(true);
  });
});

describe("validateMapping", () => {
  const headers = ["First Name", "Last Name", "Email", "Extra Column"];

  it("accepts a valid mapping with both required fields", () => {
    expect(() =>
      validateMapping({ "First Name": "firstName", "Last Name": "lastName", Email: "email" }, headers),
    ).not.toThrow();
  });

  it("rejects a mapping missing a required destination field", () => {
    expect(() => validateMapping({ "First Name": "firstName" }, headers)).toThrow(/lastName/);
  });

  it("rejects an unknown source column", () => {
    expect(() =>
      validateMapping({ "First Name": "firstName", "Last Name": "lastName", "Not A Column": "email" }, headers),
    ).toThrow(/unknown source column/i);
  });

  it("rejects two source columns mapped to the same destination", () => {
    expect(() =>
      validateMapping({ "First Name": "firstName", "Last Name": "firstName", Email: "email" }, headers),
    ).toThrow(/more than one column/i);
  });

  it("rejects a destination outside the Contact-field allowlist", () => {
    expect(() =>
      validateMapping(
        { "First Name": "firstName", "Last Name": "lastName", Email: "id" as never },
        headers,
      ),
    ).toThrow(/not a mappable/i);
  });
});
