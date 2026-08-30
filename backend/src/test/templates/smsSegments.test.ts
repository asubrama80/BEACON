import { describe, expect, it } from "vitest";
import { estimateSmsSegments } from "../../modules/templates/smsSegments.js";

describe("estimateSmsSegments", () => {
  it("classifies plain ASCII text as GSM-7", () => {
    const result = estimateSmsSegments("This is an emergency notification.");
    expect(result.encoding).toBe("GSM-7");
    expect(result.segmentCount).toBe(1);
  });

  it("fits exactly at the single-segment GSM-7 boundary (160 chars)", () => {
    const text = "a".repeat(160);
    const result = estimateSmsSegments(text);
    expect(result.encoding).toBe("GSM-7");
    expect(result.characterCount).toBe(160);
    expect(result.segmentCount).toBe(1);
  });

  it("spills into a second GSM-7 concatenated segment just past the boundary (161 chars)", () => {
    const text = "a".repeat(161);
    const result = estimateSmsSegments(text);
    expect(result.encoding).toBe("GSM-7");
    expect(result.segmentCount).toBe(2);
  });

  it("estimates multiple GSM-7 concatenated segments using the 153-char-per-segment rate", () => {
    const text = "a".repeat(306); // 2 * 153
    const result = estimateSmsSegments(text);
    expect(result.encoding).toBe("GSM-7");
    expect(result.segmentCount).toBe(2);
  });

  it("counts an extended-table character (e.g. €) as 2 GSM-7 units", () => {
    const result = estimateSmsSegments("Price: 5€");
    expect(result.encoding).toBe("GSM-7");
    expect(result.gsmUnitCount).toBe("Price: 5".length + 2);
  });

  it("classifies emoji as UCS-2", () => {
    const result = estimateSmsSegments("Emergency 🚨");
    expect(result.encoding).toBe("UCS-2");
  });

  it("fits exactly at the single-segment UCS-2 boundary (70 chars)", () => {
    const text = "🚨" + "a".repeat(69);
    const result = estimateSmsSegments(text);
    expect(result.encoding).toBe("UCS-2");
    expect(result.characterCount).toBe(70);
    expect(result.segmentCount).toBe(1);
  });

  it("spills into a second UCS-2 concatenated segment just past the boundary (71 chars)", () => {
    const text = "🚨" + "a".repeat(70);
    const result = estimateSmsSegments(text);
    expect(result.encoding).toBe("UCS-2");
    expect(result.segmentCount).toBe(2);
  });

  it("returns zero segments for empty content", () => {
    const result = estimateSmsSegments("");
    expect(result.segmentCount).toBe(0);
  });

  it("treats a message containing a placeholder token as plain GSM-7 text for estimation purposes", () => {
    // Segment estimation always runs on already-rendered content in this module's preview path —
    // documented here as the expected behavior for the raw token form too, since {{ and }} and
    // the identifier characters are all within the GSM-7 basic set.
    const result = estimateSmsSegments("Hello {{firstName}}, evacuate now.");
    expect(result.encoding).toBe("GSM-7");
  });
});
