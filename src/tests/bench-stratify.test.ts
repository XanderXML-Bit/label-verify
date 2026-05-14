import { describe, it, expect } from "vitest";
import { stratify, stratifiedCounts } from "@/lib/bench-stratify";

describe("stratify", () => {
  it("null / undefined → compliant (untagged baseline)", () => {
    expect(stratify(null)).toBe("compliant");
    expect(stratify(undefined)).toBe("compliant");
    expect(stratify("")).toBe("compliant");
  });

  it("real-photo compliant tags → compliant", () => {
    expect(stratify("C0")).toBe("compliant");
    expect(stratify("compliant")).toBe("compliant");
    expect(stratify("PASS")).toBe("compliant");
  });

  it("synthetic adversarial defect tags → adversarial", () => {
    // bold defects
    expect(stratify("B1")).toBe("adversarial");
    expect(stratify("B2")).toBe("adversarial");
    expect(stratify("B3")).toBe("adversarial");
    expect(stratify("B4")).toBe("adversarial");
    // size defects
    expect(stratify("S1")).toBe("adversarial");
    expect(stratify("S2")).toBe("adversarial");
    expect(stratify("S3")).toBe("adversarial");
    expect(stratify("S2_MINI_TINY_TEXT")).toBe("adversarial");
    expect(stratify("S2_WARNING_TOO_SMALL")).toBe("adversarial");
    // text defects
    expect(stratify("T1")).toBe("adversarial");
    expect(stratify("T2_PREFIX_LOWERCASE")).toBe("adversarial");
    expect(stratify("T1_PREFIX_TITLE_CASE")).toBe("adversarial");
    // caps defects (NOT C0)
    expect(stratify("C1")).toBe("adversarial");
    expect(stratify("C2")).toBe("adversarial");
    expect(stratify("C3")).toBe("adversarial");
    expect(stratify("C1_PREFIX_TITLE_CASE")).toBe("adversarial");
    // X defects
    expect(stratify("X1")).toBe("adversarial");
    expect(stratify("X4_MISSING_COMMA")).toBe("adversarial");
    // net-contents edge
    expect(stratify("N1_NET_CONTENTS_LETTER_O")).toBe("adversarial");
    // explicit "non-compliant-*"
    expect(stratify("non-compliant-bold")).toBe("adversarial");
    expect(stratify("non-compliant-size")).toBe("adversarial");
    expect(stratify("missing")).toBe("adversarial");
    // slash-combined tags
    expect(stratify("T1/B2")).toBe("adversarial");
  });

  it("quality-degradation tags → quality", () => {
    expect(stratify("Q2_GLARE_WARNING")).toBe("quality");
    expect(stratify("Q3_PARTIAL_OCCLUSION")).toBe("quality");
    expect(stratify("Q4_BLUR_LOW_LIGHT")).toBe("quality");
    expect(stratify("Q5_STAIN_WRINKLE")).toBe("quality");
    expect(stratify("Q6_ROTATED_180")).toBe("quality");
  });

  it("stratifiedCounts groups records by stratum", () => {
    const records = [
      { govWarningCase: "C0", condition: "correct" as const, bucket: "true-pass" },
      { govWarningCase: "C0", condition: "correct" as const, bucket: "true-pass" },
      { govWarningCase: "B1", condition: "correct" as const, bucket: "false-pass-on-correct" },
      { govWarningCase: "S2", condition: "correct" as const, bucket: "true-fail" },
      { govWarningCase: "Q4_BLUR_LOW_LIGHT", condition: "correct" as const, bucket: "review-on-correct" },
      { govWarningCase: null, condition: "correct" as const, bucket: "true-pass" },
    ];
    const out = stratifiedCounts(records);
    expect(out.compliant.n).toBe(3); // 2 C0 + 1 null
    expect(out.compliant.buckets["true-pass"]).toBe(3);
    expect(out.adversarial.n).toBe(2); // B1 + S2
    expect(out.adversarial.buckets["false-pass-on-correct"]).toBe(1);
    expect(out.adversarial.buckets["true-fail"]).toBe(1);
    expect(out.quality.n).toBe(1);
    expect(out.quality.buckets["review-on-correct"]).toBe(1);
    expect(out.unknown.n).toBe(0);
  });
});
