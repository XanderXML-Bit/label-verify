import { describe, expect, it } from "vitest";
import { validateGovernmentWarning } from "@/lib/validation/government-warning-validator";
import { GOVERNMENT_WARNING_BODY } from "@/lib/validation/government-warning";

// Simple mode shows the Government Warning reason to a visitor as-is.
// It used to read "Government Warning subscores: caps=fail, bold=review."
// (design audit 2026-11-13 P0-2).
describe("Government Warning reason is plain language", () => {
  it("explains a title-case prefix in words, citing the rule", async () => {
    const gov = await validateGovernmentWarning({
      extracted: {
        raw_text: `Government Warning: ${GOVERNMENT_WARNING_BODY}`,
        prefix_text: "Government Warning:",
        prefix_bbox: null,
        prefix_appears_bold: true,
        prefix_appears_caps: false,
      },
      declaredNetContents: { value: 750, unit: "ml" },
      imageDimsPx: { width: 1000, height: 1500 },
    });
    expect(gov.status).toBe("fail");
    expect(gov.reason).toMatch(/capital letters/);
    expect(gov.reason).toMatch(/27 CFR §16\.21/);
    expect(gov.reason).not.toMatch(/[a-z]+=(fail|review|pass)/);
    expect(gov.reason).not.toMatch(/subscores/i);
  });
});
