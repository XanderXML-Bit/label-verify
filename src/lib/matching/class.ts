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
  //
  // The two sides are "ambiguously equivalent" when:
  //   (a) they map to the SAME review-canon, AND
  //   (b) they map to DIFFERENT safe-canons (i.e., they're not already
  //       treated as identical by the SAFE_ALIASES bidirectional set).
  // The previous check used `dRev !== safeCanonical(declared)` only on
  // the declared side, which incorrectly returned false when the
  // declared value happened to be the review-canon itself (e.g.
  // declared "Lager" against extracted "Pilsner" — both review-canon
  // "lager", but declared's safe-canon is also "lager", so the old
  // check inverted to false). Per UI re-audit 2026-05-12 BLOCKER #1.
  const ambiguous = (() => {
    const dRev = reviewCanonical(declared);
    const eRev = reviewCanonical(extracted);
    return dRev === eRev && a !== b;
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
  // Wave-16: substring-relaxation REVIEW path. The declared value is
  // often a CONCISE class name (e.g. "Grenache") while the extracted
  // value is a DESCRIPTIVE label-printed string (e.g. "Grenache Red
  // Wine"). The Levenshtein-ratio comparator returns ~0.5-0.65 on
  // these length-mismatched cases — below the 0.7 REVIEW band — and
  // FAILs the field. The operator-cost is real: wave-13 traced 2 of
  // the 20 deterministic false-fails (ai-label-0065 "Grenache",
  // ai-label-0080 "Mango Lime Malt Seltzer") to this exact code
  // path.
  //
  // Safe substring escalation: when declared is wholly contained in
  // extracted (or vice versa), route the field to REVIEW with the
  // similarity ratio as confidence. The verifier no longer rejects
  // labels where the declared class name is a CONCISE form of the
  // printed text. REVIEW (not PASS) is the conservative landing —
  // a human reviewer confirms whether "Grenache" + "Grenache Red
  // Wine" is genuinely the same product (typically yes) without
  // the verifier auto-passing a potentially-different class.
  //
  // Risk: cross-class substring collisions (e.g. "Beer" ⊆ "Root
  // Beer"). The minimum-token-length guard (≥ 4 chars after
  // canonicalization) eliminates the common short-token traps; "Beer"
  // canonicalizes to "beer" which is < 5 chars, so the "beer" ⊆
  // "root beer" case is NOT escalated. Two-token+ declared values
  // pass through as the operator typed them.
  if (!pass && !review) {
    const aTrim = a.trim();
    const bTrim = b.trim();
    const minTokenLen = 5;
    const shorterLen = Math.min(aTrim.length, bTrim.length);
    if (shorterLen >= minTokenLen) {
      const shorter = aTrim.length <= bTrim.length ? aTrim : bTrim;
      const longer = aTrim.length <= bTrim.length ? bTrim : aTrim;
      if (longer.includes(shorter)) {
        return {
          field: "class_type",
          status: "review",
          expected: declared,
          actual: extracted,
          confidence: Math.min(0.65, extractedConfidence),
          reason: `Declared "${declared}" is a substring of printed "${extracted}" (or vice versa) — likely the same class with the label using a more descriptive form. Confirm.`,
        };
      }
    }
  }
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
