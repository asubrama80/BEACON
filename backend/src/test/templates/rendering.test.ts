import { describe, expect, it } from "vitest";
import { renderTemplate, validateTemplateContent } from "../../modules/templates/rendering.js";
import { samplePlaceholderValues } from "../../modules/templates/placeholders.js";

describe("validateTemplateContent", () => {
  it("accepts plain text with no placeholders", () => {
    const result = validateTemplateContent("This is an emergency notification.");
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.placeholders).toEqual([]);
  });

  it("accepts known placeholders", () => {
    const result = validateTemplateContent("Hello {{firstName}} {{lastName}} ({{displayName}}).");
    expect(result.valid).toBe(true);
    expect(result.placeholders.sort()).toEqual(["displayName", "firstName", "lastName"]);
  });

  it("tolerates whitespace inside the braces", () => {
    const result = validateTemplateContent("Hello {{ firstName }}.");
    expect(result.valid).toBe(true);
    expect(result.placeholders).toEqual(["firstName"]);
  });

  it("rejects an unknown placeholder", () => {
    const result = validateTemplateContent("Hello {{middleName}}.");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/unknown placeholder/i);
  });

  it("rejects dotted-path placeholder syntax", () => {
    const result = validateTemplateContent("{{user.password}}");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/malformed placeholder/i);
  });

  it("rejects function-call-like placeholder syntax", () => {
    const result = validateTemplateContent("{{foo()}}");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/malformed placeholder/i);
  });

  it("rejects handlebars-style block syntax", () => {
    const result = validateTemplateContent("{{#each contacts}}{{firstName}}{{/each}}");
    expect(result.valid).toBe(false);
  });

  it("rejects a reserved-looking identifier even though it's syntactically a bare word", () => {
    const result = validateTemplateContent("{{constructor}}");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/unknown placeholder/i);
  });

  it("rejects ${...} expression syntax", () => {
    const result = validateTemplateContent("Total: ${something}");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/\$\{\.\.\.\}/);
  });

  it("rejects <% %> template-code syntax", () => {
    const result = validateTemplateContent("<% code %>");
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/<% %>/);
  });
});

describe("renderTemplate", () => {
  it("substitutes known placeholders with provided values", () => {
    const result = renderTemplate({
      body: "Hello {{firstName}}, this is an emergency notification.",
      values: samplePlaceholderValues(),
    });
    expect(result.renderedBody).toBe("Hello Alex, this is an emergency notification.");
    expect(result.unresolvedPlaceholders).toEqual([]);
  });

  it("renders both subject and body for email-shaped input", () => {
    const result = renderTemplate({
      subject: "Notice for {{firstName}}",
      body: "Dear {{displayName}}, please review.",
      values: samplePlaceholderValues(),
    });
    expect(result.renderedSubject).toBe("Notice for Alex");
    expect(result.renderedBody).toBe("Dear Alex Morgan, please review.");
  });

  it("leaves an unresolved placeholder as its original token and reports it explicitly", () => {
    const result = renderTemplate({ body: "Hello {{firstName}} {{lastName}}.", values: { firstName: "Alex" } });
    expect(result.renderedBody).toBe("Hello Alex {{lastName}}.");
    expect(result.unresolvedPlaceholders).toEqual(["lastName"]);
  });

  it("never evaluates content as code — a literal ${} in body-only text passes through untouched", () => {
    // renderTemplate itself doesn't validate — that's validateTemplateContent's job — but it
    // must never attempt to evaluate this as a JS template literal either.
    const result = renderTemplate({ body: "Price: ${100}", values: {} });
    expect(result.renderedBody).toBe("Price: ${100}");
  });
});
