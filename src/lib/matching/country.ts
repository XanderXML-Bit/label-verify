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

export function compareCountry(
  declared: string,
  extracted: string | null,
  extractedConfidence: number,
): FieldComparison {
  if (!extracted) {
    return {
      field: "country_of_origin",
      status: "fail",
      expected: declared,
      actual: null,
      confidence: 0,
      reason: "No country of origin found on the label.",
    };
  }
  const a = canonicalize(declared);
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
