import { fuzzy as ratio } from "fast-fuzzy";
import type { ProducerAddress } from "../vision/types";
import type { FieldComparison, FieldStatus } from "./index";
import { normalizeBrand } from "./brand";

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

// USPS two-letter state codes. If a label's producer block shows a US
// state (e.g. "Portland, ME 04101"), most labels do NOT also print
// "USA" — the country is implied by the state. Pre-2026-05 the
// producer comparator counted `extracted.country = null` as a hard
// mismatch even when state was a US state, producing a REVIEW status
// on labels that were actually correct. The set below is the fix.
const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC", "PR",
]);

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
    US_STATE_CODES.has(extractedState.toUpperCase()) &&
    hasCorroboratingComponent
  ) {
    return "pass";
  }
  return "fail";
}

export function compareProducer(
  declared: ProducerAddress | string,
  extracted: ProducerAddress | null,
  extractedConfidence: number,
): FieldComparison {
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
  };
}
