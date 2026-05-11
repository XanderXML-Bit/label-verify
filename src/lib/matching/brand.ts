import { fuzzy as ratio } from "fast-fuzzy";
import type { FieldComparison } from "./index";

/**
 * Brand-name fuzzy comparator. R6: "STONE'S THROW" ≡ "Stone's Throw".
 *
 * Two-signal approach to avoid Levenshtein instability on short brands:
 *  - Levenshtein-ratio threshold (default 0.92) for character-level similarity.
 *  - Token-set ratio (default 0.85) — handles word reordering ("Brewing Co.
 *    Stone's Throw" vs "Stone's Throw Brewing Co.") and gates against
 *    short-brand false positives ("Coors Light" vs "Coots Light" where
 *    char-ratio is misleadingly high).
 *
 * BOTH thresholds must pass for a PASS. One pass + one near-miss → REVIEW.
 * Neither → FAIL.
 */

const DEFAULT_LEV_THRESHOLD = 0.92;
const DEFAULT_TOKEN_THRESHOLD = 0.85;
const REVIEW_BAND = 0.85; // either signal below this on its own → fail

export function normalizeBrand(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSetRatio(a: string, b: string): number {
  const tokensA = new Set(a.split(" ").filter(Boolean));
  const tokensB = new Set(b.split(" ").filter(Boolean));
  const inter = new Set<string>();
  for (const t of tokensA) if (tokensB.has(t)) inter.add(t);
  const sorted = [...inter].sort().join(" ");
  const restA = [...tokensA].filter((t) => !inter.has(t)).sort().join(" ");
  const restB = [...tokensB].filter((t) => !inter.has(t)).sort().join(" ");
  const t0 = sorted;
  const t1 = (sorted + " " + restA).trim();
  const t2 = (sorted + " " + restB).trim();
  const r1 = ratio(t0, t1);
  const r2 = ratio(t0, t2);
  const r3 = ratio(t1, t2);
  return Math.max(r1, r2, r3);
}

export function compareBrand(
  declared: string,
  extracted: string | null,
  options: { levThreshold?: number; tokenThreshold?: number } = {},
): FieldComparison {
  if (!extracted) {
    return {
      field: "brand_name",
      status: "fail",
      expected: declared,
      actual: null,
      confidence: 0,
      reason: "No brand name found on the label.",
    };
  }
  const levT = options.levThreshold ?? DEFAULT_LEV_THRESHOLD;
  const tokT = options.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD;
  const a = normalizeBrand(declared);
  const b = normalizeBrand(extracted);
  const lev = ratio(a, b);
  const tok = tokenSetRatio(a, b);
  const both = Math.min(lev, tok);

  const passes = lev >= levT && tok >= tokT;
  const reviewing =
    !passes && lev >= REVIEW_BAND && tok >= REVIEW_BAND;

  return {
    field: "brand_name",
    status: passes ? "pass" : reviewing ? "review" : "fail",
    expected: declared,
    actual: extracted,
    confidence: both,
    reason: passes
      ? undefined
      : reviewing
        ? `Close but not a confident match (Levenshtein ${lev.toFixed(2)}, token-set ${tok.toFixed(2)}). Human review.`
        : `Declared brand and label brand do not match closely enough (Levenshtein ${lev.toFixed(2)}, token-set ${tok.toFixed(2)}).`,
  };
}
