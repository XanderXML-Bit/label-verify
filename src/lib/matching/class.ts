import { fuzzy as ratio } from "fast-fuzzy";
import type { FieldComparison } from "./index";
import { normalizeBrand } from "./brand";

/**
 * Class / type comparator. The declared class is part of a controlled
 * vocabulary (per the COLA form: beer, wine, distilled spirits, etc.)
 * and the printed class on the label is usually a more specific style
 * within that category — e.g. declared "India Pale Ale", printed
 * "INDIA PALE ALE" or "IPA."
 *
 * Strategy:
 *  - Normalize both sides.
 *  - SAFE aliases (synonyms / abbreviations) → PASS.
 *  - AMBIGUOUS aliases (meaningfully-distinct styles that some labels
 *    use interchangeably) → REVIEW. A pilsner is not a lager from a
 *    TTB labeling-truth perspective, but legacy taxonomies treated
 *    them as equivalent. Defer to a human.
 *  - Else Levenshtein ratio ≥ 0.85 → PASS.
 */

// Pure abbreviations / spelling variants. Always safe to treat as PASS.
const SAFE_ALIASES: Record<string, string[]> = {
  "india pale ale": ["ipa"],
  "double india pale ale": ["dipa"],
  "pale ale": ["apa", "american pale ale"],
  "cabernet sauvignon": ["cab", "cabernet"],
  "chardonnay": ["chard"],
  "pinot noir": ["pinot"],
  "sauvignon blanc": ["sauv blanc"],
  // Whisk(e)y spelling variants — Scottish/Irish-style spelling vs
  // American/Canadian, but the controlled term is the same product.
  "whiskey": ["whisky"],
  "bourbon whiskey": ["bourbon"],
  "scotch whisky": ["scotch"],
};

// Ambiguous aliases — different styles that some labels use loosely.
// Imperial IPA ≠ DIPA exactly; pilsner ≠ lager; imperial stout ≠ stout.
// These get REVIEW, not PASS, so a reviewer can confirm.
const REVIEW_ALIASES: Record<string, string[]> = {
  "double india pale ale": ["imperial ipa"],
  "lager": ["pilsner", "pils"],
  "stout": ["imperial stout"],
};

function safeCanonical(s: string): string {
  const n = normalizeBrand(s);
  for (const [canon, aliases] of Object.entries(SAFE_ALIASES)) {
    if (n === canon || aliases.includes(n)) return canon;
  }
  return n;
}

function reviewCanonical(s: string): string {
  const n = normalizeBrand(s);
  for (const [canon, aliases] of Object.entries(REVIEW_ALIASES)) {
    if (n === canon || aliases.includes(n)) return canon;
  }
  return n;
}

export function compareClass(
  declared: string,
  extracted: string | null,
  extractedConfidence: number,
): FieldComparison {
  if (!extracted) {
    return {
      field: "class_type",
      status: "fail",
      expected: declared,
      actual: null,
      confidence: 0,
      reason: "No class / type found on the label.",
    };
  }
  const a = safeCanonical(declared);
  const b = safeCanonical(extracted);
  if (a === b) {
    return {
      field: "class_type",
      status: "pass",
      expected: declared,
      actual: extracted,
      confidence: extractedConfidence,
    };
  }
  // Check ambiguous aliases — pilsner/lager, imperial stout/stout, etc.
  // These print interchangeably on real labels but are not literally the
  // same style. Surface as REVIEW so a human confirms.
  const ambiguous = (() => {
    const dRev = reviewCanonical(declared);
    const eRev = reviewCanonical(extracted);
    return dRev === eRev && dRev !== safeCanonical(declared);
  })();
  if (ambiguous) {
    return {
      field: "class_type",
      status: "review",
      expected: declared,
      actual: extracted,
      confidence: Math.min(0.7, extractedConfidence),
      reason: `Declared "${declared}" and printed "${extracted}" are commonly used as synonyms but refer to meaningfully different styles — please confirm.`,
    };
  }
  const r = ratio(a, b);
  const pass = r >= 0.85;
  const review = !pass && r >= 0.7;
  return {
    field: "class_type",
    status: pass ? "pass" : review ? "review" : "fail",
    expected: declared,
    actual: extracted,
    confidence: Math.min(r, extractedConfidence),
    reason: pass
      ? undefined
      : `Declared "${declared}" vs printed "${extracted}" (similarity ${r.toFixed(2)}).`,
  };
}
