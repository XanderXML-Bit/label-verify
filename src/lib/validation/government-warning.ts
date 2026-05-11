// Government Warning validator constants. The strictest field — implementation
// in Phase 5. Federal regulations: 27 CFR § 16.21 (text + bold + caps) and
// 27 CFR § 16.22 (type-size minimums).
//
// See docs/government-warning-cases.md for the enumerated non-compliance
// taxonomy this validator is built to catch.

// ─── 27 CFR § 16.21: prescribed text ────────────────────────────────────────

// The two-word prefix is the bold-rule target. The colon belongs to the
// punctuation-bearing PREFIX_FULL form, NOT to the bold test.
export const PREFIX_BOLD_TARGET = "GOVERNMENT WARNING";

// PREFIX_FULL = PREFIX_BOLD_TARGET + ":"; concatenation made explicit so the
// separator contract is testable.
export const PREFIX_FULL = `${PREFIX_BOLD_TARGET}:`;

// The body text per 27 CFR § 16.21, verbatim. Do not paraphrase.
export const GOVERNMENT_WARNING_BODY =
  "(1) According to the Surgeon General, women should not drink alcoholic " +
  "beverages during pregnancy because of the risk of birth defects. " +
  "(2) Consumption of alcoholic beverages impairs your ability to drive a " +
  "car or operate machinery, and may cause health problems.";

// Canonical full statement = prefix + single space + body. Defined as a
// helper rather than a string constant so the separator is explicit.
export const SEPARATOR_BETWEEN_PREFIX_AND_BODY = " ";
export const canonicalStatement = (): string =>
  PREFIX_FULL + SEPARATOR_BETWEEN_PREFIX_AND_BODY + GOVERNMENT_WARNING_BODY;

// ─── 27 CFR § 16.22: type-size minimums ─────────────────────────────────────

/** Containers ≤ 237 ml use the small-container minimum. */
export const SMALL_CONTAINER_THRESHOLD_ML = 237;
/** Minimum glyph height for containers > 237 ml. */
export const MIN_TYPE_HEIGHT_MM_LARGE = 2;
/** Minimum glyph height for containers ≤ 237 ml. */
export const MIN_TYPE_HEIGHT_MM_SMALL = 1;

// ─── Bold-detection thresholds (relative, not absolute) ─────────────────────

/**
 * Bold is inherently relative. We measure the prefix stroke width on the
 * same image as the body stroke width and require:
 *   stroke_ratio = prefix / body  ≥ BOLD_RATIO_PASS  → bold
 *   stroke_ratio                  ≤ BOLD_RATIO_FAIL  → not bold
 *   between                                            → REVIEW (human)
 */
export const BOLD_RATIO_PASS = 1.4;
export const BOLD_RATIO_FAIL = 1.2;

// ─── Validator output ───────────────────────────────────────────────────────

export type SubscoreStatus = "pass" | "fail" | "review";

export interface GovernmentWarningSubscores {
  text: SubscoreStatus;
  caps: SubscoreStatus;
  bold: SubscoreStatus;
  size: SubscoreStatus;
}

export interface GovernmentWarningCheck {
  /**
   * Aggregate verdict. Equals min(subscores) — one weak signal poisons
   * the field, which is the right semantic for a strict rule.
   */
  status: SubscoreStatus;
  /**
   * Aggregate confidence = min(per-subscore confidence). Same reasoning.
   */
  confidence: number;
  subscores: GovernmentWarningSubscores;
  /** Per-subscore confidence so the UI can show why a REVIEW is REVIEW. */
  subscoreConfidence: Record<keyof GovernmentWarningSubscores, number>;
  /** Specific reason on FAIL or REVIEW. Empty on PASS. */
  reason?: string;
}

// ─── Normalization helpers ──────────────────────────────────────────────────

/**
 * Normalize text for the strict text-match subscore. Folds Unicode
 * compatibility forms, smart-quote variants, and excess whitespace —
 * without ever touching letter case (the caps subscore needs the original).
 */
export function normalizeForTextMatch(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True iff the prefix is all caps after Unicode-folding small-caps
 * codepoints (U+1D00–U+1D2C and friends) into their uppercase Latin
 * equivalents. Stub for Phase 5 — tested in src/tests/.
 */
export function isPrefixAllCaps(prefix: string): boolean {
  const folded = prefix.normalize("NFKC");
  return folded === folded.toUpperCase() && /[A-Z]/.test(folded);
}
