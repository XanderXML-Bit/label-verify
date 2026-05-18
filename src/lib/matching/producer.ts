import { fuzzy as ratio } from "fast-fuzzy";
import type { ProducerAddress } from "../vision/types";
import type { FieldComparison, FieldStatus } from "./index";
import { normalizeBrand } from "./brand";
import { canonicalizeCountry, recognisedCountry } from "./country";

// US state + territory abbreviations. Single canonical set used by:
//   (a) the wave-33 producer string-declared country gate, to avoid
//       mis-canonicalising state-code tokens (CA, IT, IN, DE, MX, etc.)
//       as ISO-2 country codes when they appear in the comma-separated
//       tail of a declared producer string;
//   (b) the implicit-USA inference in `countryStatus`, to validate
//       that an `extracted.state` is a real US state code before
//       inferring USA on labels with no explicit country marking.
//
// Wave-33 audit pass 3 consolidated two near-duplicate sets in this
// file (US_STATE_ABBREVS + US_STATE_CODES) into one canonical
// definition so future updates can't drift between them. Coverage:
// 50 states + DC + 5 TTB-jurisdiction territories.
const US_STATE_ABBREVS = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR", "VI", "GU", "AS", "MP",
]);

/**
 * Producer / address comparator. The declared producer may be a structured
 * object OR a freeform string (legacy); we accept both. Compare per
 * component when both sides are structured, fall back to whole-string
 * fuzzy match otherwise.
 *
 * Per-component results so the UI can show "street matches, city doesn't"
 * instead of collapsing to one FAIL.
 */

const COMPONENT_THRESHOLD = 0.86;

// (Wave-33 pass 3) Removed the duplicate `US_STATE_CODES` set — the
// canonical `US_STATE_ABBREVS` above is now the single source of truth
// for both the string-declared country gate and the implicit-USA
// inference in `countryStatus`.

function isUsa(s: string | null | undefined): boolean {
  if (!s) return false;
  const t = s.toUpperCase().replace(/[^A-Z]/g, "");
  return t === "USA" || t === "US" || t === "UNITEDSTATES" ||
    t === "UNITEDSTATESOFAMERICA";
}

function normalize(s: string | null | undefined): string {
  return s ? normalizeBrand(s) : "";
}

function statusFor(declared: string, actual: string | null): FieldStatus {
  if (!declared) return "pass"; // nothing to check
  if (!actual) return "fail";
  return ratio(normalize(declared), normalize(actual)) >= COMPONENT_THRESHOLD
    ? "pass"
    : "fail";
}

/**
 * Country comparator with implicit-USA inference. Real TTB labels
 * routinely omit an explicit country line — they rely on the state
 * (e.g. "Portland, ME 04101") to imply USA.
 *
 * SECURITY: the inference is only applied when the extracted state is
 * a strict-format US state code AND at least one other producer
 * component (street / city / postal_code) ALSO matches the declared
 * structured address. Without those guards, a hallucinated
 * `extracted.state = "ME"` could downgrade a clearly-non-compliant
 * label (e.g. "Producer: …, Mexico") to PASS on the country axis. See
 * the 2026-05-12 security audit, finding #2 + #3.
 */
function countryStatus(
  declaredCountry: string,
  extractedCountry: string | null,
  extractedState: string | null,
  hasCorroboratingComponent: boolean,
): FieldStatus {
  if (!declaredCountry) return "pass";
  // The label printed an explicit country — use the standard rule.
  if (extractedCountry) {
    return ratio(normalize(declaredCountry), normalize(extractedCountry)) >=
      COMPONENT_THRESHOLD
      ? "pass"
      : "fail";
  }
  // No explicit country on the label. Infer USA only when:
  //   1. declared is USA
  //   2. extracted state is a strict-format US state code (no
  //      punctuation, no noise); validates against the canonical form
  //      BEFORE upper-casing so we don't silently accept "m.e." etc.
  //   3. at least one OTHER producer component matches — so a
  //      hallucinated state alone can't downgrade a non-compliant
  //      Mexico-produced label.
  if (
    isUsa(declaredCountry) &&
    extractedState &&
    /^[A-Za-z]{2}$/.test(extractedState) &&
    US_STATE_ABBREVS.has(extractedState.toUpperCase()) &&
    hasCorroboratingComponent
  ) {
    return "pass";
  }
  return "fail";
}

export function compareProducer(
  declared: ProducerAddress | string | null | undefined,
  extracted: ProducerAddress | null,
  extractedConfidence: number,
): FieldComparison {
  // Wave-34 audit fix #13: when the applicant did not declare a
  // producer at all (form submitted blank), route to REVIEW rather
  // than the previous silent PASS (empty-vs-empty fuzzy match) or
  // hard FAIL (empty-vs-anything). Producer is a TTB-required field
  // on COLA applications per 27 CFR §4.32 / §5.32, so a missing
  // declaration is a regulatory signal the operator must confirm —
  // it isn't a "the label matches the application" question, it's
  // a "the application is incomplete" one.
  const declaredIsMissing =
    declared == null ||
    (typeof declared === "string" && declared.trim() === "");
  if (declaredIsMissing) {
    return {
      field: "producer",
      status: "review",
      expected: null,
      actual: extracted,
      confidence: 0.4,
      reason:
        "Application did not declare a producer / importer. TTB requires this field on COLA applications (27 CFR §4.32 / §5.32) — confirm whether the applicant intended to leave it blank, or fill it in and re-verify.",
    };
  }
  if (!extracted) {
    return {
      field: "producer",
      status: "fail",
      expected: declared,
      actual: null,
      confidence: 0,
      reason: "No producer / address found on the label.",
    };
  }

  if (typeof declared === "string") {
    const decl = normalize(declared);
    // Try to compare against the joined extracted fields.
    const joined = [
      extracted.name,
      extracted.street,
      extracted.city,
      extracted.state,
      extracted.postal_code,
      extracted.country,
    ]
      .filter(Boolean)
      .join(" ");
    const r = ratio(decl, normalize(joined));

    // Wave-33 audit (Sub-agent A bug #14): regulator-disqualifying
    // country gate on the string-declared path. The structured-declared
    // path already runs `compareCountry` against `declared.country`
    // and forces FAIL on canonical mismatch; the string path
    // previously did fuzzy-string-only, so "...San Diego, CA, USA" vs
    // an extracted MEXICO country could PASS at similarity ~0.93
    // because one token-swap is below the threshold. We now extract
    // the trailing country-like token from the declared string and
    // canonicalise both sides; a mismatch is a hard FAIL regardless
    // of overall similarity. Per 27 CFR §4.39 / §5.36 country marking
    // is a compliance-critical field.
    //
    // Wave-33 pass 3 (asymmetric-gate fix, Hermes critique): the
    // gate originally only fired when `extracted.country` was non-null,
    // which left the symmetric hole open: declared "...Mexico" vs
    // `extracted.country = null` would skip the gate entirely and fall
    // through to fuzzy-only. Mirror `compareCountry` semantics: when
    // declared parses to a non-USA country and extracted prints no
    // country, that's an import-marking FAIL (27 CFR §4.39 / §5.36).
    // When declared parses to USA and extracted is null, we DON'T
    // force FAIL (US-domestic labels legitimately omit country
    // marking) — defer to the fuzzy ratio below.
    {
      // Take up to the last 2 comma-separated segments as country candidates
      // (covers "..., CA, USA" and "..., USA" but not the street/city tail).
      //
      // Self-audit fix (wave-33, sub-agent pass 2): the previous version
      // walked `tail` in array order and short-circuited on the FIRST
      // recognised match. That was wrong because 2-letter tokens like
      // `CA` / `IT` / `IN` / `DE` / `MX` / `IE` / `CH` are simultaneously
      // (a) US state abbreviations and (b) ISO-2 country codes in our
      // SYNONYMS table. On "Stone Brewing Co., San Diego, CA, USA",
      // `tail = ["CA","USA"]` and the old short-circuit returned
      // `canonical("CA") === "canada"`, then compared "canada" vs the
      // extracted USA — incorrectly forcing FAIL on a fully compliant
      // US label. Two-part fix:
      //   1. Walk `tail` from RIGHT to LEFT so the trailing segment
      //      (where country marking actually lives) wins.
      //   2. Skip 2-letter tokens that match a US state abbreviation
      //      (they're disambiguating context, not the country claim).
      const segs = declared.split(/,/).map((s) => s.trim()).filter(Boolean);
      const tail = segs.slice(-2);
      let tailRecognised: string | null = null;
      let tailRecognisedDisplay = "";
      for (let i = tail.length - 1; i >= 0; i--) {
        const t = tail[i]!;
        if (US_STATE_ABBREVS.has(t.toUpperCase())) continue;
        const c = recognisedCountry(t);
        if (c !== null) {
          tailRecognised = c;
          tailRecognisedDisplay = t;
          break;
        }
      }
      if (tailRecognised) {
        if (extracted.country) {
          const extractedCanon = canonicalizeCountry(extracted.country).canon;
          if (tailRecognised !== extractedCanon) {
            return {
              field: "producer",
              status: "fail",
              expected: declared,
              actual: extracted,
              confidence: 1,
              reason: `Declared producer country (${tailRecognisedDisplay}) does not match extracted (${extracted.country}). 27 CFR §4.39 / §5.36 require country-of-origin marking to match the application.`,
            };
          }
        } else if (tailRecognised !== "united states") {
          // Declared parses to a non-USA country, but the label prints
          // no country marking at all. That's an import-marking
          // violation regardless of how well the rest of the address
          // matches (27 CFR §4.39 / §5.36). US-domestic labels are
          // exempt and fall through to fuzzy.
          return {
            field: "producer",
            status: "fail",
            expected: declared,
            actual: extracted,
            confidence: 1,
            reason: `Declared producer country (${tailRecognisedDisplay}) requires country-of-origin marking on the label per 27 CFR §4.39 / §5.36, but the extracted label has none.`,
          };
        }
      }
    }

    // Wave-35 Track 1 #1: emit passReason on the string-declared fuzzy
    // PASS bin when the similarity ratio was non-exact (0.86 ≤ r < 0.99).
    // A perfect r === 1.0 PASS gets no passReason.
    const fuzzyPassReason: string | undefined =
      r >= COMPONENT_THRESHOLD && r < 0.99
        ? `Fuzzy match accepted: declared producer string vs joined extracted address fields at similarity ${r.toFixed(2)} (above the ${COMPONENT_THRESHOLD.toFixed(2)} threshold).`
        : undefined;
    return {
      field: "producer",
      status: r >= COMPONENT_THRESHOLD ? "pass" : r >= 0.75 ? "review" : "fail",
      expected: declared,
      actual: extracted,
      confidence: Math.min(r, extractedConfidence),
      reason:
        r >= COMPONENT_THRESHOLD
          ? undefined
          : `Producer / address similarity ${r.toFixed(2)} below threshold.`,
      ...(fuzzyPassReason ? { passReason: fuzzyPassReason } : {}),
    };
  }

  // Score the address-shaped components first so the country check
  // can require at least one of them to be a corroborating PASS.
  const nameStatus = statusFor(declared.name ?? "", extracted.name);
  const streetStatus = statusFor(declared.street ?? "", extracted.street);
  const cityStatus = statusFor(declared.city ?? "", extracted.city);
  const stateStatus = statusFor(declared.state ?? "", extracted.state);
  const postalStatus = statusFor(
    declared.postal_code ?? "",
    extracted.postal_code,
  );
  // "Corroborating component" excludes `state` itself, since the
  // implicit-USA rule already inspects state — using it as its own
  // corroborator would be circular.
  const corroborating =
    nameStatus === "pass" ||
    streetStatus === "pass" ||
    cityStatus === "pass" ||
    postalStatus === "pass";
  const components: Record<string, FieldStatus> = {
    name: nameStatus,
    street: streetStatus,
    city: cityStatus,
    state: stateStatus,
    postal_code: postalStatus,
    country: countryStatus(
      declared.country ?? "",
      extracted.country,
      extracted.state,
      corroborating,
    ),
  };

  const fails = Object.values(components).filter((s) => s === "fail").length;
  // Country mismatch is regulator-disqualifying on its own — a label
  // that prints a different country than the declared application is
  // a hard TTB FAIL regardless of how many address components happen
  // to coincidentally match (e.g. Portland, ME exists in both Maine
  // and several other countries' city lists). Per code-review C1.
  const status: FieldStatus =
    components.country === "fail"
      ? "fail"
      : fails === 0
        ? "pass"
        : fails <= 1
          ? "review"
          : "fail";

  // Wave-35c PASS reasoning for the structured-producer compound bin.
  // Status PASS here means every component matched its respective
  // threshold (statusFor uses COMPONENT_THRESHOLD = 0.86). When at
  // least one component matched non-exactly (fuzzy ratio < 1.0) OR
  // country was inferred via implicit-USA, surface a summary so an
  // auditor sees WHICH components were exact and which required
  // tolerance. Trivial all-exact PASSes (every component exact-string)
  // get no passReason.
  const componentSummary: string[] = [];
  if (status === "pass") {
    type SP = ProducerAddress;
    const dExact = (k: keyof SP, raw: string | null) =>
      ((declared as SP)[k] ?? "") === (raw ?? "");
    const fields: Array<keyof SP> = [
      "name",
      "street",
      "city",
      "state",
      "postal_code",
    ];
    const fuzzyNonExact: string[] = [];
    for (const f of fields) {
      const declVal = (declared as SP)[f] ?? "";
      const extVal = extracted[f];
      if (declVal && extVal && !dExact(f, extVal)) {
        fuzzyNonExact.push(f.replace("_", " "));
      }
    }
    // Country PASS reason — was it the standard match or the
    // implicit-USA-from-state inference path? The inference fires
    // when declared.country is USA AND extracted.country is null AND
    // extracted.state is a US state AND a corroborating component
    // matched.
    const countryInferred =
      isUsa(declared.country ?? "") &&
      !extracted.country &&
      !!extracted.state &&
      US_STATE_ABBREVS.has(extracted.state.toUpperCase()) &&
      corroborating;
    if (countryInferred) {
      componentSummary.push(
        "country implicit US-domestic (declared USA + extracted state " +
          extracted.state +
          " corroborated by another component)",
      );
    }
    if (fuzzyNonExact.length > 0) {
      componentSummary.push(
        `${fuzzyNonExact.length} component${fuzzyNonExact.length === 1 ? "" : "s"} fuzzy-matched (${fuzzyNonExact.join(", ")})`,
      );
    }
  }
  const passReason: string | undefined =
    status === "pass" && componentSummary.length > 0
      ? `All producer components accepted — ${componentSummary.join("; ")}.`
      : undefined;
  return {
    field: "producer",
    status,
    expected: declared,
    actual: extracted,
    confidence: extractedConfidence,
    components,
    reason:
      status === "pass"
        ? undefined
        : components.country === "fail"
          ? `Country component disagrees (declared "${declared.country ?? "—"}" vs printed "${extracted.country ?? "—"}") — regulator-disqualifying regardless of other component matches.`
          : `${fails} producer component${fails === 1 ? "" : "s"} did not match.`,
    ...(passReason ? { passReason } : {}),
  };
}
