import type { FieldComparison } from "./index";
import { normalizeBrand } from "./brand";

/**
 * Country of origin. Strict equality after normalization (R7). We also
 * accept common ISO-3166 alpha-2 ↔ name mappings ("USA" ≡ "US" ≡ "United
 * States"), and case-insensitive comparison.
 */

const ALIASES: Record<string, string[]> = {
  "united states": ["usa", "us", "u.s.", "u.s.a.", "united states of america"],
  "united kingdom": ["uk", "u.k.", "great britain", "england"],
  france: ["fr"],
  italy: ["it"],
  spain: ["es"],
  germany: ["de"],
  ireland: ["ie"],
  mexico: ["mx"],
  canada: ["ca"],
};

function canonicalize(s: string): string {
  const n = normalizeBrand(s);
  for (const [canon, aliases] of Object.entries(ALIASES)) {
    if (n === normalizeBrand(canon)) return canon;
    for (const a of aliases) {
      if (n === normalizeBrand(a)) return canon;
    }
  }
  return n;
}

// Domestic-USA labels routinely omit an explicit country marking — TTB
// regulations only mandate country-of-origin text for IMPORTS (27 CFR
// §4.39, §5.36). When a US-produced bottle's front label doesn't
// print "USA" / "Product of USA", the model correctly returns null,
// and the previous comparator marked that FAIL — the dominant cause
// of false-FAILs on the photo-realistic OOD corpus (Codex AI labels
// over-claim country_of_origin="USA" on labels that don't visibly
// state one). The fix: if declared is USA and extracted is null,
// REVIEW (let a human confirm it's domestic) rather than hard FAIL.
// Non-US declared with null extracted stays FAIL — country marking
// IS required for imports.
function isUsaCanonical(c: string): boolean {
  return c === "united states";
}

export function compareCountry(
  declared: string,
  extracted: string | null,
  extractedConfidence: number,
): FieldComparison {
  const a = canonicalize(declared);
  if (!extracted) {
    if (isUsaCanonical(a)) {
      return {
        field: "country_of_origin",
        status: "review",
        expected: declared,
        actual: null,
        confidence: 0.5,
        reason:
          "Label does not visibly print a country of origin. Most US-produced beverages omit it (TTB requires it for imports only, per 27 CFR §4.39 / §5.36). Reviewer should confirm the producer address is US-based.",
      };
    }
    return {
      field: "country_of_origin",
      status: "fail",
      expected: declared,
      actual: null,
      confidence: 0,
      reason:
        "No country of origin found on the label. Imports must visibly state the country of origin per 27 CFR §4.39 / §5.36.",
    };
  }
  const b = canonicalize(extracted);
  const pass = a === b;
  return {
    field: "country_of_origin",
    status: pass ? "pass" : "fail",
    expected: declared,
    actual: extracted,
    confidence: extractedConfidence,
    reason: pass
      ? undefined
      : `Declared "${declared}" vs printed "${extracted}".`,
  };
}
