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

// ─── Generic class names + their accepted specific subtypes ─────────────────
//
// Wave-24 (2026-05-13): some labels print only the GENERIC class designation
// ("WINE", "BEER", "MALT BEVERAGE", "DISTILLED SPIRITS") while the COLA
// application declares a more specific style ("Grenache", "Lager", "Mango
// Lime Malt Seltzer", "Bourbon Whiskey"). These are not actually
// mismatches — TTB class-of-fitness regulations (27 CFR §4.32 for wine,
// §7.22 for malt beverages, §5.22 for distilled spirits) allow the
// generic family name as a class designation. The pre-wave-24 comparator
// had no concept of family-subtype relationships, so the Levenshtein
// similarity between e.g. "Grenache" and "WINE" came in at ~0.25 and
// the field FAILed.
//
// Conservative landing: when the label's class string is a recognised
// GENERIC family name AND the declared class is a known subtype of that
// family, route the field to REVIEW (not PASS). Same rationale as the
// wave-16 substring REVIEW path: a human reviewer is the right place
// to confirm "the application says Grenache, the label says WINE,
// which is technically compliant, but please double-check the bottle
// is actually a Grenache." This trades a `false-fail` (correct-GT) for
// a `review-on-correct` — a strictly safer routing.
//
// For the WRONG-GT versions of these images (perturbation swapped the
// specific subtype to a *different* subtype within the same family,
// e.g. ai-label-0065 wrong-GT swaps Grenache → Cabernet Sauvignon),
// the verifier *cannot* distinguish a different-varietal mismatch
// from the label alone if the label only says "WINE". A REVIEW
// landing on those wrong-GT cases is regulator-defensible: the
// extracted label content doesn't actually contradict the declared
// application, so a strict FAIL would be over-rejection. REVIEW
// hands the disambiguation to the reviewer who can look at any
// other on-bottle indicia.
//
// Subtype lists are NOT exhaustive — kept to common varietals / styles
// that appear in real COLA applications. New entries should match the
// canonicalized form returned by `normalizeBrand` (already lower-cased
// + punctuation-stripped). The 4 generic families correspond to the
// `class_category` enum in `DeclaredFieldsSchema`.

const GENERIC_CLASS_FAMILIES: Record<string, Set<string>> = {
  // Wine — varietals + style designations
  wine: new Set([
    "chardonnay", "cabernet sauvignon", "cabernet", "merlot", "pinot noir",
    "pinot grigio", "pinot gris", "sauvignon blanc", "riesling", "zinfandel",
    "sangiovese", "grenache", "syrah", "shiraz", "tempranillo", "malbec",
    "rose", "rosé", "champagne", "sparkling wine", "prosecco", "moscato",
    "viognier", "gewurztraminer", "gewürztraminer", "chenin blanc",
    "red wine", "white wine", "blush wine", "table wine", "dessert wine",
    "fortified wine", "port", "sherry", "madeira", "marsala", "vermouth",
  ]),
  // Beer + malt beverages — styles
  beer: new Set([
    "lager", "ale", "ipa", "india pale ale", "double india pale ale",
    "dipa", "stout", "porter", "pilsner", "pils", "wheat beer",
    "hefeweizen", "saison", "tripel", "dubbel", "quad", "kolsch",
    "kölsch", "amber ale", "pale ale", "brown ale", "blonde ale",
    "imperial stout", "imperial ipa", "barley wine", "barleywine",
    "sour ale", "gose", "lambic", "bock", "doppelbock", "schwarzbier",
    "marzen", "märzen", "rauchbier",
    // Malt-beverage subtypes that share class_category="beer" in the schema
    "malt beverage", "malt liquor", "hard seltzer", "malt seltzer",
    "flavored malt beverage",
  ]),
  // Distilled spirits — styles
  "distilled spirits": new Set([
    "whiskey", "whisky", "bourbon", "bourbon whiskey", "rye", "rye whiskey",
    "scotch", "scotch whisky", "irish whiskey", "japanese whisky",
    "vodka", "rum", "white rum", "dark rum", "spiced rum", "aged rum",
    "gin", "london dry gin", "tequila", "blanco tequila", "reposado tequila",
    "anejo tequila", "añejo tequila", "mezcal", "brandy", "cognac",
    "armagnac", "calvados", "schnapps", "absinthe", "liqueur", "cordial",
    "vermouth", "aperitif", "digestif",
  ]),
  // Fortified wine (separate category in schema)
  "fortified wine": new Set([
    "port", "sherry", "madeira", "marsala", "vermouth", "sake",
  ]),
};

// Canonicalised generic-family names that the label may print verbatim.
const GENERIC_CLASS_NAMES: Set<string> = new Set([
  "wine", "beer", "ale", // "ale" by itself is generic enough to be a family
  "malt beverage", "malt beverages",
  "distilled spirits", "spirits", "liquor",
  "fortified wine",
]);

function genericFamilyOf(canon: string): string | null {
  if (!GENERIC_CLASS_NAMES.has(canon)) return null;
  // Map the printed-generic name back to the schema family key.
  if (canon === "wine") return "wine";
  if (canon === "fortified wine") return "fortified wine";
  if (canon === "beer" || canon === "ale" || canon === "malt beverage" || canon === "malt beverages")
    return "beer";
  if (canon === "distilled spirits" || canon === "spirits" || canon === "liquor")
    return "distilled spirits";
  return null;
}

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
  // Wave-24: generic-class-on-label-vs-specific-on-application path.
  // When the label prints just "WINE" / "BEER" / "MALT BEVERAGE" /
  // "DISTILLED SPIRITS" and the declared value matches (or contains)
  // a known subtype of that family, route to REVIEW. This is the
  // structural recovery for the 3 deterministic false-fails on
  // ai-label-0065 (Grenache / WINE), 0076 (Lager / BEER), and
  // 0080 (Mango Lime Malt Seltzer / MALT BEVERAGE). PASS would be
  // defensible too, but REVIEW is the strictly safer landing — it
  // preserves sharp rejection on the wrong-GT perturbations (which
  // usually swap one subtype for another within the same family).
  //
  // Matching is "subtype is a token-substring of declared" (e.g.
  // "Mango Lime Malt Seltzer" contains "malt seltzer"). This catches
  // descriptive declared values that pre-pend qualifiers or flavor
  // descriptors to a recognised style name without forcing the
  // table to enumerate every possible descriptor. We require a
  // minimum subtype length of 4 chars after canonicalization to
  // avoid 3-letter tokens like "ipa" matching inside unrelated
  // declared strings (e.g. "wikipedia" — unlikely on a COLA
  // application, but cheap to guard against).
  if (!pass && !review) {
    const family = genericFamilyOf(b);
    if (family) {
      const subtypes = GENERIC_CLASS_FAMILIES[family];
      const declaredCanon = a; // already normalized
      const matchedSubtype = subtypes
        ? [...subtypes].find(
            (st) =>
              st.length >= 4 &&
              (declaredCanon === st ||
                declaredCanon.includes(` ${st}`) ||
                declaredCanon.includes(`${st} `) ||
                declaredCanon.endsWith(` ${st}`) ||
                declaredCanon.startsWith(`${st} `)),
          )
        : undefined;
      if (matchedSubtype) {
        return {
          field: "class_type",
          status: "review",
          expected: declared,
          actual: extracted,
          confidence: Math.min(0.65, extractedConfidence),
          reason: `The label prints the generic class "${extracted}" while the application declares the specific subtype "${declared}". TTB regs allow either form, but the label alone cannot confirm the declared subtype — please confirm the bottle matches the application.`,
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
