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
 * Bold is inherently relative. We measure the prefix mean-stroke-thickness
 * on the same image as the body mean-stroke-thickness and bucket the
 * ratio:
 *   ratio ≥ BOLD_RATIO_PASS     → bold (pass)
 *   ratio ≤ BOLD_RATIO_FAIL     → not bold (fail)
 *   in between                  → ambiguous → REVIEW (human resolves)
 *
 * Thresholds calibrated against test-data-v2/ (Inter font, sharp PNG):
 *   Compliant (Bold prefix, Regular body):  ratio 1.58–3.97 (min 1.58)
 *   B1 same-weight prefix and body:         ratio ≈ 1.0     (by construction)
 *   B2 prefix Regular, body Bold:           ratio < 1.0
 *   B3 prefix Medium (500) vs body Regular: ratio ≈ 1.1–1.3 (review band)
 *
 * The 1.15 / 1.50 split puts B1/B2 in the fail band, B3 in review, and
 * compliant comfortably above pass. See `scripts/calibrate-bold.ts` for
 * the calibration run that produced these bands.
 */
export const BOLD_RATIO_PASS = 1.5;
export const BOLD_RATIO_FAIL = 1.15;

// ─── Validator output ───────────────────────────────────────────────────────

/**
 * Tri-state used for every subscore and for the aggregate verdict.
 * Ordering for min-aggregation (see status priorities below):
 *   fail < review < pass
 */
export type SubscoreStatus = "pass" | "fail" | "review";

/** Strict ordering so we can take the "min" across subscores. */
const STATUS_RANK: Record<SubscoreStatus, number> = {
  fail: 0,
  review: 1,
  pass: 2,
};

/**
 * Aggregate the per-subscore statuses by taking the *worst* one.
 * One weak signal poisons the field — which is the right semantic for a
 * strict regulatory rule. Exported so the harness and the API route share
 * the same aggregation logic.
 */
export function aggregateStatus(subs: SubscoreStatus[]): SubscoreStatus {
  // An empty subscores array is a programming error — there is no
  // meaningful aggregation. Past behaviour silently returned "pass",
  // which is the dangerous default (per code review finding #11). Throw
  // instead so a refactor that drops the subscores hits a test
  // failure in development, not a false PASS in production.
  if (subs.length === 0) {
    throw new Error(
      "aggregateStatus: cannot aggregate an empty subscores array.",
    );
  }
  let worst: SubscoreStatus = "pass";
  for (const s of subs) {
    if (STATUS_RANK[s] < STATUS_RANK[worst]) worst = s;
  }
  return worst;
}

export interface SubscoreResult {
  status: SubscoreStatus;
  /** 0–1; per-subscore self-confidence. */
  confidence: number;
}

export interface GovernmentWarningSubscores {
  text: SubscoreResult;
  caps: SubscoreResult;
  bold: SubscoreResult;
  size: SubscoreResult;
}

export interface GovernmentWarningCheck {
  /**
   * Aggregate verdict — `aggregateStatus(subscore statuses)`. One weak
   * signal poisons the field.
   */
  status: SubscoreStatus;
  /**
   * Aggregate confidence = minimum confidence across all four subscores.
   * Same reasoning as `status`: the field is only as confident as its
   * weakest subscore.
   */
  confidence: number;
  subscores: GovernmentWarningSubscores;
  /** Specific reason on FAIL or REVIEW. Empty on PASS. */
  reason?: string;
  /**
   * Wave-35c — non-trivial PASS reasoning. Emitted ONLY when status
   * is PASS AND at least one subscore was borderline (e.g. bold
   * detected at 0.85–0.95 confidence) or fallback path was used.
   * A summary like "All 4 subscores PASS — text exact, caps PASS,
   * bold confidence 0.92, size at 1.4× the §16.21 minimum." A
   * regulator-audit answer to "why was this PASS?" without the
   * reviewer having to inspect every subscore chip. Trivial all-
   * high-confidence PASSes get no passReason.
   */
  passReason?: string;
}

// ─── Normalization helpers ──────────────────────────────────────────────────

/**
 * Normalize text for the strict text-match subscore. Folds Unicode
 * compatibility forms, smart-quote variants, dash variants, ellipsis
 * variants, excess whitespace, and (wave-23) letter case.
 *
 * The orthogonal `scoreCaps` subscore is independent and remains case-
 * sensitive — it specifically checks that the prefix is uppercase. So
 * the regulation's actual case requirement (prefix in caps + bold)
 * is still enforced; we just stopped enforcing it on the body where
 * it was never required by 27 CFR §16.21.
 *
 * Also folds non-printing space variants (NBSP U+00A0, narrow NBSP
 * U+202F, en/em spaces U+2002..U+2005, zero-width spaces U+200B/U+FEFF)
 * to a regular space before the `\s+` collapse. Without this, a
 * verbatim federal warning exported from a Canadian / European DTP
 * pipeline (which often emits NBSP between "GOVERNMENT" and "WARNING"
 * or around punctuation) returns text-mismatch even though the visible
 * text is identical. Per Agent D accuracy audit 2026-05-13.
 */
export function normalizeForTextMatch(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    // Fold non-printing / non-ASCII space variants to a regular
    // space BEFORE the s+ collapse below. NFKC already folds many
    // of these, but not zero-width forms. Codepoints folded:
    //   U+00A0 NBSP, U+1680 Ogham,
    //   U+2000..U+200A en-quad through hair-space,
    //   U+202F narrow NBSP, U+205F medium math space,
    //   U+3000 ideographic, U+200B zero-width, U+FEFF BOM.
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u200B\uFEFF]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Case-fold (wave-23, 2026-05-13). 27 CFR \u00A716.21 requires the
    // *prefix* in caps + bold (enforced by the orthogonal scoreCaps
    // subscore); the body has no case requirement. All-caps body is
    // compliant \u2014 7 of the 12 deterministic false-fails on the cross-
    // pair bench (ai-label-0002/5/6/7/8/31/50) all share the same
    // defect: their body is rendered in all caps and the pre-wave-23
    // case-sensitive comparison treated it as a paraphrase defect.
    // Paraphrase-class differences (missing/wrong words, wrong
    // punctuation) are still caught \u2014 only the case variant is
    // accepted here. Canonical text is ASCII-only so locale-sensitive
    // folding (Turkish dotless-i et al.) is not a concern.
    .toLowerCase();
}

/**
 * Latin small-capital codepoints in the U+1D00 block (ᴀ, ʙ, ᴄ, …) print
 * uppercase-shaped but compare lowercase under simple `===` toUpperCase
 * checks. Map them to their uppercase Latin equivalents before the caps
 * check so a small-caps font does not silently fail.
 *
 * Source: Unicode Phonetic Extensions block (U+1D00 – U+1D2B).
 */
const SMALL_CAPS_TO_UPPER: Record<string, string> = {
  "ᴀ": "A", "ᴁ": "Æ", "ᴃ": "B", "ᴄ": "C", "ᴅ": "D",
  "ᴇ": "E", "ᴈ": "Ǝ", "ᴉ": "I", "ᴊ": "J", "ᴋ": "K",
  "ᴌ": "L", "ᴍ": "M", "ᴎ": "N", "ᴏ": "O", "ᴐ": "Ɔ",
  "ᴑ": "Ø", "ᴒ": "Ǫ", "ᴓ": "Ơ", "ᴔ": "Œ", "ᴕ": "ȢȚ",
  "ᴖ": "Ɵ", "ᴗ": "ʘ", "ᴘ": "P", "ᴙ": "Ⱳ", "ᴚ": "R",
  "ᴛ": "T", "ᴜ": "U", "ᴝ": "Ʉ", "ᴞ": "Ʋ", "ᴟ": "Ǝ",
  "ᴠ": "V", "ᴡ": "W", "ᴢ": "Z",
};

/**
 * True iff the prefix is all caps after Unicode-folding small-caps
 * codepoints (U+1D00 – U+1D2B) into their uppercase Latin equivalents.
 * Tested in `src/tests/` against the C1–C3 caps cases in
 * `docs/government-warning-cases.md`.
 */
export function isPrefixAllCaps(prefix: string): boolean {
  let folded = "";
  for (const ch of prefix.normalize("NFKC")) {
    folded += SMALL_CAPS_TO_UPPER[ch] ?? ch;
  }
  return folded === folded.toUpperCase() && /[A-Z]/.test(folded);
}
