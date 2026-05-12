import type { FieldComparison } from "./index";

/**
 * ABV comparator. Class-aware percentage-point tolerance per
 * TEST-STRATEGY.md §7:
 *   beer:             ±0.3 pp absolute
 *   wine < 14% ABV:   ±0.5 pp absolute
 *   wine ≥ 14% ABV:   ±1.0 pp absolute
 *   distilled spirits ±0.15 pp absolute
 *   fortified wine:   ±1.0 pp absolute
 *
 * "Percentage points," not "percent" — i.e. an additive band, not
 * relative. 6.4 ± 0.3 is [6.1, 6.7], not 6.4 × (1 ± 0.003).
 */

export type ClassCategory =
  | "beer"
  | "wine"
  | "distilled_spirits"
  | "fortified_wine";

export function abvTolerancePP(cls: ClassCategory, abv: number): number {
  switch (cls) {
    case "beer":
      return 0.3;
    case "wine":
      return abv < 14 ? 0.5 : 1.0;
    case "distilled_spirits":
      return 0.15;
    case "fortified_wine":
      return 1.0;
  }
}

export function compareAbv(
  declared: number,
  cls: ClassCategory,
  extracted: number | null,
  extractedConfidence: number,
): FieldComparison {
  if (extracted === null || Number.isNaN(extracted)) {
    return {
      field: "abv_percent",
      status: "fail",
      expected: declared,
      actual: null,
      confidence: 0,
      reason: "No ABV value found on the label.",
    };
  }
  const tol = abvTolerancePP(cls, declared);
  const delta = Math.abs(declared - extracted);
  const pass = delta <= tol;
  // Even a passing match returns REVIEW if the extractor confidence is low.
  // Floor bumped from 0.60 → 0.70 to align with the intelligence-first
  // deferral policy: when the extractor isn't confident, prefer a human.
  const review = pass && extractedConfidence < 0.7;
  return {
    field: "abv_percent",
    status: review ? "review" : pass ? "pass" : "fail",
    expected: declared,
    actual: extracted,
    confidence: extractedConfidence,
    reason: pass
      ? review
        ? `ABV matches within ±${tol} pp but extractor confidence is low (${extractedConfidence.toFixed(2)}).`
        : undefined
      : `Declared ${declared}% vs printed ${extracted}% — off by ${delta.toFixed(2)} pp (allowed ±${tol} pp for ${cls}).`,
  };
}
