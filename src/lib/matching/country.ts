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
//
// TTB COLA applications come in from every alcohol-importing country
// on Earth, so the comparator has to recognise country names in their
// LOCAL languages as well as English. Examples that hit production:
//   • "PRODUCTO DE EE. UU." (Spanish for "Product of USA")
//     — caught by the OOD corpus re-audit (ai-label-0012).
//   • "DEUTSCHLAND" (German for "Germany") — a German wine import.
//   • "日本" (Japanese for "Japan") — sake imports.
//   • "FRANÇAISE" / "FRANCE" on Bordeaux labels.
//   • Country abbreviations on EU CN-codes (FR-XX-YYY format).
//
// The table covers the ~25 countries that account for the majority of
// US alcohol imports (TTB COLA Public Registry by source country, 2024).
// Anything missing falls back to a strict normalized-string compare,
// which still works for English-named countries with US-spelled
// declarations.
const SYNONYMS: Record<string, string[]> = {
  "united states": [
    "usa",
    "us",
    "u.s.",
    "u.s.a.",
    "united states of america",
    // Spanish.
    "estados unidos",
    "estados unidos de america",
    "ee.uu.",
    "ee. uu.",
    "eeuu",
    "producto de ee.uu.",
    "producto de ee. uu.",
    "producto de estados unidos",
    // French (used on Quebec bilingual labels imported from Canada).
    "etats-unis",
    "états-unis",
    "produit des états-unis",
    "produit des etats-unis",
    // German.
    "vereinigte staaten",
    // Portuguese.
    "estados unidos da america",
    "produto dos eua",
    // Italian.
    "stati uniti",
    "prodotto degli stati uniti",
  ],
  "united kingdom": [
    "uk",
    "u.k.",
    "great britain",
    "britain",
    "england",
    "scotland",
    "wales",
    "northern ireland",
    "royaume-uni",
    "vereinigtes königreich",
  ],
  france: [
    "fr",
    "république française",
    "republique francaise",
    "francia",
    "frankreich",
  ],
  italy: ["it", "italia", "italie", "italien", "repubblica italiana"],
  spain: ["es", "españa", "espana", "espagne", "spanien", "reino de españa"],
  germany: [
    "de",
    "deutschland",
    "bundesrepublik deutschland",
    "allemagne",
    "alemania",
  ],
  ireland: ["ie", "éire", "eire", "republic of ireland", "irlanda", "irlande"],
  mexico: ["mx", "méxico", "mexique", "estados unidos mexicanos"],
  canada: ["ca", "canadá"],
  netherlands: ["nl", "holland", "the netherlands", "nederland", "pays-bas"],
  belgium: ["be", "belgique", "belgië", "belgien"],
  portugal: ["pt", "república portuguesa"],
  switzerland: [
    "ch",
    "suisse",
    "schweiz",
    "svizzera",
    "confederazione svizzera",
  ],
  austria: ["at", "österreich", "oesterreich", "autriche"],
  poland: ["pl", "polska", "polen", "pologne"],
  japan: ["jp", "japón", "japon", "日本", "nihon", "nippon"],
  china: ["cn", "中国", "zhōngguó", "people's republic of china"],
  "south korea": ["kr", "korea", "republic of korea", "대한민국", "한국"],
  australia: ["au", "australie", "australien"],
  "new zealand": ["nz", "nouvelle-zélande", "neuseeland", "aotearoa"],
  argentina: ["ar", "república argentina"],
  chile: ["cl", "república de chile"],
  brazil: ["br", "brasil", "brésil", "brasilien"],
  "south africa": ["za", "afrique du sud", "südafrika", "rsa"],
  greece: ["gr", "ελλάδα", "ellada", "hellas", "grèce", "griechenland"],
  russia: ["ru", "russian federation", "россия", "rossiya"],
  // Common wine-region declarations (constituent regions roll up below).
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
  declared: string | null | undefined,
  extracted: string | null,
  extractedConfidence: number,
): FieldComparison {
  // Declared = null means the applicant did not list a country, which
  // is legitimate for US-domestic labels (TTB only mandates country
  // marking on imports per 27 CFR §4.39 / §5.36). PASS if the label
  // also has no country marking; REVIEW if the label DOES mark one
  // (the applicant should confirm whether they meant to declare it).
  if (declared == null || declared === "") {
    if (!extracted) {
      return {
        field: "country_of_origin",
        status: "pass",
        expected: null,
        actual: null,
        confidence: 0.7,
      };
    }
    return {
      field: "country_of_origin",
      status: "review",
      expected: null,
      actual: extracted,
      confidence: 0.5,
      reason: `Application did not declare a country of origin, but the label prints "${extracted}". Verify whether the applicant intended to declare it.`,
    };
  }
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
