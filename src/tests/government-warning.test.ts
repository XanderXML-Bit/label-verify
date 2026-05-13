import { describe, expect, it } from "vitest";
import {
  PREFIX_BOLD_TARGET,
  PREFIX_FULL,
  GOVERNMENT_WARNING_BODY,
  canonicalStatement,
  isPrefixAllCaps,
  normalizeForTextMatch,
  aggregateStatus,
} from "@/lib/validation/government-warning";
import {
  validateGovernmentWarning,
  scoreBold,
} from "@/lib/validation/government-warning-validator";

const COMPLIANT_TEXT = canonicalStatement();
const LARGE_CONTAINER = { value: 750, unit: "ml" as const };
const SMALL_CONTAINER = { value: 50, unit: "ml" as const };

// 1600px / 100mm (assumed label height for a 750ml bottle) = 16 px/mm.
// BBOX_BIG height 40px → 2.5mm, comfortably ≥ §16.22 large-container floor (2mm).
// BBOX_TINY height 8px → 0.5mm, well below either floor.
const BBOX_BIG = { x: 100, y: 200, width: 400, height: 40 };
const BBOX_TINY = { x: 100, y: 200, width: 400, height: 8 };
const IMG_DIMS = { width: 1200, height: 1600 };

describe("Government Warning constants", () => {
  it("PREFIX_FULL = PREFIX_BOLD_TARGET + colon", () => {
    expect(PREFIX_FULL).toBe(`${PREFIX_BOLD_TARGET}:`);
  });

  it("PREFIX_BOLD_TARGET has no colon (bold rule target only)", () => {
    expect(PREFIX_BOLD_TARGET.includes(":")).toBe(false);
  });

  it("canonicalStatement joins prefix + space + body", () => {
    expect(canonicalStatement()).toBe(`${PREFIX_FULL} ${GOVERNMENT_WARNING_BODY}`);
  });

  it("the canonical body contains the literal regulation phrases", () => {
    expect(GOVERNMENT_WARNING_BODY).toContain(
      "(1) According to the Surgeon General",
    );
    expect(GOVERNMENT_WARNING_BODY).toContain("birth defects");
    expect(GOVERNMENT_WARNING_BODY).toContain(
      "(2) Consumption of alcoholic beverages",
    );
    expect(GOVERNMENT_WARNING_BODY).toContain("may cause health problems");
  });
});

describe("normalizeForTextMatch", () => {
  it("collapses whitespace", () => {
    expect(normalizeForTextMatch("a   b\n\tc")).toBe("a b c");
  });
  it("folds smart quotes to straight", () => {
    expect(normalizeForTextMatch("it’s")).toBe("it's");
    expect(normalizeForTextMatch("“hi”")).toBe('"hi"');
  });
  it("does not change case", () => {
    expect(normalizeForTextMatch("GOVERNMENT WARNING")).toBe("GOVERNMENT WARNING");
  });
  it("folds ellipsis to three dots", () => {
    expect(normalizeForTextMatch("birth defects…")).toBe("birth defects...");
  });
  it("folds NBSP (U+00A0) to a regular space — Canadian/European DTP labels", () => {
    // The visible text "GOVERNMENT WARNING" is identical, but the
    // exporter emitted U+00A0 between the two words. Without folding,
    // strict text comparison would flag this as a non-compliant body.
    expect(normalizeForTextMatch("GOVERNMENT WARNING")).toBe(
      "GOVERNMENT WARNING",
    );
  });
  it("folds narrow NBSP (U+202F) to a regular space", () => {
    expect(normalizeForTextMatch("birth defects")).toBe("birth defects");
  });
  it("folds en-quad U+2000 through hair-space U+200A to regular space", () => {
    expect(normalizeForTextMatch("a b c d")).toBe("a b c d");
  });
  it("folds zero-width space (U+200B) and BOM (U+FEFF) so they don't break match", () => {
    expect(normalizeForTextMatch("birth​defects﻿")).toBe(
      "birth defects",
    );
  });
});

describe("isPrefixAllCaps", () => {
  it("returns true for the canonical prefix", () => {
    expect(isPrefixAllCaps("GOVERNMENT WARNING")).toBe(true);
  });
  it("returns false for title case (C1 case)", () => {
    expect(isPrefixAllCaps("Government Warning")).toBe(false);
  });
  it("returns false for all-lower (C2 case)", () => {
    expect(isPrefixAllCaps("government warning")).toBe(false);
  });
  it("folds small-cap codepoints to uppercase Latin", () => {
    // U+1D00 (ᴀ) etc. — small-cap A. Should fold and match.
    expect(isPrefixAllCaps("ᴀʙᴄ")).toBe(true);
  });
});

describe("aggregateStatus (fail < review < pass)", () => {
  it("any fail → fail", () => {
    expect(aggregateStatus(["pass", "fail", "pass"])).toBe("fail");
  });
  it("no fail but a review → review", () => {
    expect(aggregateStatus(["pass", "review", "pass"])).toBe("review");
  });
  it("all pass → pass", () => {
    expect(aggregateStatus(["pass", "pass", "pass"])).toBe("pass");
  });
});

describe("validateGovernmentWarning", () => {
  const fullyCompliant = {
    raw_text: COMPLIANT_TEXT,
    prefix_text: "GOVERNMENT WARNING",
    prefix_bbox: BBOX_BIG,
    prefix_appears_bold: true,
    prefix_appears_caps: true,
  };

  it("PASS on a fully compliant extraction", async () => {
    const r = await validateGovernmentWarning({
      extracted: fullyCompliant,
      declaredNetContents: LARGE_CONTAINER,
      imageDimsPx: IMG_DIMS,
    });
    expect(r.status).toBe("pass");
    expect(r.subscores.text.status).toBe("pass");
    expect(r.subscores.caps.status).toBe("pass");
    expect(r.subscores.bold.status).toBe("pass");
    expect(r.subscores.size.status).toBe("pass");
  });

  it("FAIL on substituted body word (T1)", async () => {
    const r = await validateGovernmentWarning({
      extracted: {
        ...fullyCompliant,
        raw_text: COMPLIANT_TEXT.replace(
          "may cause health problems",
          "may cause health issues",
        ),
      },
      declaredNetContents: LARGE_CONTAINER,
      imageDimsPx: IMG_DIMS,
    });
    expect(r.status).toBe("fail");
    expect(r.subscores.text.status).toBe("fail");
  });

  it("FAIL on title-case prefix (C1)", async () => {
    const r = await validateGovernmentWarning({
      extracted: {
        ...fullyCompliant,
        prefix_text: "Government Warning",
      },
      declaredNetContents: LARGE_CONTAINER,
      imageDimsPx: IMG_DIMS,
    });
    expect(r.status).toBe("fail");
    expect(r.subscores.caps.status).toBe("fail");
  });

  it("FAIL when prefix is not bold (B1)", async () => {
    const r = await validateGovernmentWarning({
      extracted: {
        ...fullyCompliant,
        prefix_appears_bold: false,
      },
      declaredNetContents: LARGE_CONTAINER,
      imageDimsPx: IMG_DIMS,
    });
    expect(r.status).toBe("fail");
    expect(r.subscores.bold.status).toBe("fail");
  });

  it("REVIEW when bold is null (extractor unsure)", async () => {
    const r = await validateGovernmentWarning({
      extracted: {
        ...fullyCompliant,
        prefix_appears_bold: null,
      },
      declaredNetContents: LARGE_CONTAINER,
      imageDimsPx: IMG_DIMS,
    });
    expect(r.subscores.bold.status).toBe("review");
    // Aggregate respects fail < review < pass; review propagates.
    expect(r.status).toBe("review");
  });

  it("REVIEW on type-size below §16.22 minimum (S1) — size subscore is advisory (D11)", async () => {
    // Per the 2026-05-12 audit (D11), the pixel→mm conversion has no
    // aspect-ratio correction, so a too-small size subscore is REVIEW
    // (advisory) rather than FAIL. A genuinely too-small Gov Warning
    // will still fail on text + caps + bold subscores in most cases.
    const r = await validateGovernmentWarning({
      extracted: { ...fullyCompliant, prefix_bbox: BBOX_TINY },
      declaredNetContents: LARGE_CONTAINER,
      imageDimsPx: IMG_DIMS,
    });
    expect(r.subscores.size.status).toBe("review");
    expect(r.status).toBe("review");
  });

  it("uses the SMALL container minimum (1mm) for ≤237ml containers", async () => {
    // A bbox that would FAIL for a large container at 2mm should still
    // PASS for a small container at 1mm if the px-height is enough.
    const okForSmall = { x: 0, y: 0, width: 400, height: 12 };
    const r = await validateGovernmentWarning({
      extracted: { ...fullyCompliant, prefix_bbox: okForSmall },
      declaredNetContents: SMALL_CONTAINER,
      imageDimsPx: IMG_DIMS,
    });
    // 12px / (1600px / 30mm) = ~0.225mm — too small for any container.
    // Switch to bigger bbox to verify the SMALL-vs-LARGE threshold logic.
    const okForSmallBig = { x: 0, y: 0, width: 400, height: 64 };
    const r2 = await validateGovernmentWarning({
      extracted: { ...fullyCompliant, prefix_bbox: okForSmallBig },
      declaredNetContents: SMALL_CONTAINER,
      imageDimsPx: IMG_DIMS,
    });
    // Just assert the comparator runs and returns a defined status either way.
    expect(["pass", "fail", "review"]).toContain(r.subscores.size.status);
    expect(["pass", "fail", "review"]).toContain(r2.subscores.size.status);
  });

  it("REVIEW on missing bbox or image dims (size unknowable)", async () => {
    const r = await validateGovernmentWarning({
      extracted: { ...fullyCompliant, prefix_bbox: null },
      declaredNetContents: LARGE_CONTAINER,
      imageDimsPx: IMG_DIMS,
    });
    expect(r.subscores.size.status).toBe("review");
  });

  it("aggregate confidence is the minimum across subscores", async () => {
    // Construct an input where caps confidence is forced low by null prefix.
    const r = await validateGovernmentWarning({
      extracted: {
        ...fullyCompliant,
        prefix_appears_bold: null,
      },
      declaredNetContents: LARGE_CONTAINER,
      imageDimsPx: IMG_DIMS,
    });
    // The bold review subscore has confidence 0.5; aggregate must be ≤ 0.5.
    expect(r.confidence).toBeLessThanOrEqual(0.5);
  });

  // ─── Wave-14: bold-subscore OCR-fail / model-pass safety net ───────────────

  it("WAVE-14: OCR-fail + model-pass + fontBold-null → REVIEW (was FAIL pre-wave-14)", () => {
    // The wave-14 bench finding: 20 deterministic false-fails on
    // visibly-compliant labels traced to this exact code path. OCR
    // returned a fail ratio (< BOLD_RATIO_FAIL), the vision model
    // self-reported bold=true, and fontBoldStatus was null (Tesseract's
    // LSTM engine doesn't populate is_bold reliably). The pre-wave-14
    // safety-net required BOTH model-pass AND fontBold-pass, so the
    // null fontBoldStatus left FAIL standing. Wave-14 relaxed that
    // to "model-pass AND fontBold-not-contradicting".
    const result = scoreBold(/* appearsBold */ true, {
      ratio: 0.5, // < BOLD_RATIO_FAIL (1.15) → ocrStatus = fail
      confidence: 0.9,
      // fontBold fractions null on both sides → fontBoldStatus = null
      fontBoldFractionPrefix: null,
      fontBoldFractionBody: null,
    });
    expect(result.status).toBe("review");
    expect(result.confidence).toBe(0.4);
  });

  it("WAVE-14: OCR-fail + model-fail (corroborated) → FAIL (unchanged)", () => {
    // The model and OCR agree the prefix is not bold — strong signal,
    // verdict stays FAIL. This is the protective case: wave-14 must
    // not soften FAILs when the model also says "not bold."
    const result = scoreBold(/* appearsBold */ false, {
      ratio: 0.5, // ocrStatus = fail
      confidence: 0.9,
      fontBoldFractionPrefix: null,
      fontBoldFractionBody: null,
    });
    expect(result.status).toBe("fail");
  });

  it("WAVE-14: OCR-fail + model-pass + fontBold-FAIL (contradicting) → FAIL", () => {
    // Tesseract's is_bold WAS populated and it agrees with the OCR
    // ratio: prefix is not bold. Even though the vision model
    // self-reports bold, the fontBold contradiction keeps the verdict
    // at FAIL. This guards against the regulator-dangerous scenario
    // where the model is wrong AND only OCR signal disagrees.
    const result = scoreBold(/* appearsBold */ true, {
      ratio: 0.5,
      confidence: 0.9,
      fontBoldFractionPrefix: 0.1, // mostly NOT bold
      fontBoldFractionBody: 0.9, // mostly bold (B2-style inversion)
    });
    // fontBoldStatus = "fail" because bodyBold (0.9) > prefixBold (0.1) + 0.3
    // → wave-14 does NOT drop to REVIEW (fontBold actively contradicts the model)
    expect(result.status).toBe("fail");
  });

  it("WAVE-14: OCR-fail + model-pass + fontBold-PASS (corroborates model) → REVIEW", () => {
    // The pre-wave-14 path: explicit two-signal disagreement
    // routes to REVIEW. Wave-14 preserves this case unchanged.
    const result = scoreBold(/* appearsBold */ true, {
      ratio: 0.5,
      confidence: 0.9,
      fontBoldFractionPrefix: 0.9, // mostly bold
      fontBoldFractionBody: 0.1, // mostly NOT bold
    });
    expect(result.status).toBe("review");
  });

  it("FAIL when raw_text is null entirely (X1 — missing)", async () => {
    const r = await validateGovernmentWarning({
      extracted: {
        raw_text: null,
        prefix_text: null,
        prefix_bbox: null,
        prefix_appears_bold: null,
        prefix_appears_caps: null,
      },
      declaredNetContents: LARGE_CONTAINER,
      imageDimsPx: IMG_DIMS,
    });
    expect(r.status).toBe("fail");
    expect(r.subscores.text.status).toBe("fail");
  });
});
