import type { FieldComparison } from "./index";
import { normalizeBrand } from "./brand";

/**
 * Country of origin. Strict equality after normalization (R7). We also
 * accept common ISO-3166 alpha-2 ↔ name mappings ("USA" ≡ "US" ≡ "United
 * States"), and case-insensitive comparison.
 *
 * Sub-regions vs synonyms: "Scotland", "Wales", "England", and "Northern
 * Ireland" are CONSTITUENT COUNTRIES of the United Kingdom — distinct
 * from each other but each a valid TTB country-of-origin for a UK
 * declaration. The comparator handles them asymmetrically:
 *  - declared "United Kingdom" + extracted "Scotland" → PASS
 *  - declared "Scotland" + extracted "United Kingdom" → PASS
 *  - declared "Scotland" + extracted "Scotland" → PASS
 *  - declared "Scotland" + extracted "Wales" → FAIL (different
 *    constituent countries, the TTB cares).
 * This is the same logic that prevents declared "Bavaria" matching
 * extracted "Hesse" if Germany ever gets the same treatment. Per
 * code-review C2.
 */

// True synonyms — bidirectional, interchangeable in any direction.
const SYNONYMS: Record<string, string[]> = {
  "united states": ["usa", "us", "u.s.", "u.s.a.", "united states of america"],
  "united kingdom": ["uk", "u.k.", "great britain"],
  france: ["fr"],
  italy: ["it"],
  spain: ["es"],
  germany: ["de"],
  ireland: ["ie"],
  mexico: ["mx"],
  canada: ["ca"],
};

// Constituent / sub-regions — they roll up TO the canon, but the
// canon does NOT collapse them together. Scotland and Wales both
// resolve to "united kingdom" only when compared against the canon
// itself; against each other they are distinct.
const SUB_REGIONS: Record<string, string[]> = {
  "united kingdom": ["england", "scotland", "wales", "northern ireland"],
};

interface Canon {
  /** Canonical country (e.g. "united kingdom"). */
  canon: string;
  /** Sub-region tag if the input was a constituent country (e.g. "scotland"). */
  subRegion: string | null;
}

function canonicalize(s: string): Canon {
  const n = normalizeBrand(s);
  for (const [canon, synonyms] of Object.entries(SYNONYMS)) {
    if (n === normalizeBrand(canon)) return { canon, subRegion: null };
    for (const a of synonyms) {
      if (n === normalizeBrand(a)) return { canon, subRegion: null };
    }
  }
  for (const [canon, regions] of Object.entries(SUB_REGIONS)) {
    for (const r of regions) {
      if (n === normalizeBrand(r)) return { canon, subRegion: r };
    }
  }
  return { canon: n, subRegion: null };
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
    if (isUsaCanonical(a.canon)) {
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
  // Different canons → mismatch.
  if (a.canon !== b.canon) {
    return {
      field: "country_of_origin",
      status: "fail",
      expected: declared,
      actual: extracted,
      confidence: extractedConfidence,
      reason: `Declared "${declared}" vs printed "${extracted}".`,
    };
  }
  // Same canon. If both are sub-regions, they must be the SAME sub-
  // region — different constituent countries within the same canon
  // still mismatch for TTB labelling. One side being the canon
  // itself (or a true synonym, where subRegion=null) is always fine.
  if (a.subRegion !== null && b.subRegion !== null && a.subRegion !== b.subRegion) {
    return {
      field: "country_of_origin",
      status: "fail",
      expected: declared,
      actual: extracted,
      confidence: extractedConfidence,
      reason: `Declared "${declared}" vs printed "${extracted}" — both roll up to "${a.canon}" but are distinct constituent countries.`,
    };
  }
  return {
    field: "country_of_origin",
    status: "pass",
    expected: declared,
    actual: extracted,
    confidence: extractedConfidence,
  };
}
