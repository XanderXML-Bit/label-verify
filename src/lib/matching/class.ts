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
 *  - Accept short-form aliases (IPA ↔ India Pale Ale, etc.).
 *  - Else Levenshtein ratio ≥ 0.85 → PASS.
 */

const ALIASES: Record<string, string[]> = {
  "india pale ale": ["ipa"],
  "double india pale ale": ["dipa", "imperial ipa"],
  "pale ale": ["apa", "american pale ale"],
  "lager": ["pilsner", "pils"],
  "stout": ["imperial stout"],
  "cabernet sauvignon": ["cab", "cabernet"],
  "chardonnay": ["chard"],
  "pinot noir": ["pinot"],
  "sauvignon blanc": ["sauv blanc"],
  "whiskey": ["whisky"],
  "bourbon whiskey": ["bourbon"],
  "scotch whisky": ["scotch"],
};

function canonical(s: string): string {
  const n = normalizeBrand(s);
  for (const [canon, aliases] of Object.entries(ALIASES)) {
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
  const a = canonical(declared);
  const b = canonical(extracted);
  if (a === b) {
    return {
      field: "class_type",
      status: "pass",
      expected: declared,
      actual: extracted,
      confidence: extractedConfidence,
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
