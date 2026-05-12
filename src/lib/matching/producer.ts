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
 * (e.g. "Portland, ME 04101") to imply USA. If the declared country
 * is USA and the extracted state is a recognised US state code, we
 * accept null/empty extracted.country as PASS. Otherwise fall back to
 * the same fuzzy-match rule used for the other components.
 */
function countryStatus(
  declaredCountry: string,
  extractedCountry: string | null,
  extractedState: string | null,
): FieldStatus {
  if (!declaredCountry) return "pass";
  // The label printed an explicit country — use the standard rule.
  if (extractedCountry) {
    return ratio(normalize(declaredCountry), normalize(extractedCountry)) >=
      COMPONENT_THRESHOLD
      ? "pass"
      : "fail";
  }
  // No explicit country on the label. If declared is USA AND the
  // producer state is a US state code, infer USA. This matches how
  // real labels are printed.
  if (isUsa(declaredCountry) && extractedState) {
    const code = extractedState.toUpperCase().replace(/[^A-Z]/g, "");
    if (US_STATE_CODES.has(code)) return "pass";
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

  const components: Record<string, FieldStatus> = {
    name: statusFor(declared.name ?? "", extracted.name),
    street: statusFor(declared.street ?? "", extracted.street),
    city: statusFor(declared.city ?? "", extracted.city),
    state: statusFor(declared.state ?? "", extracted.state),
    postal_code: statusFor(declared.postal_code ?? "", extracted.postal_code),
    country: countryStatus(
      declared.country ?? "",
      extracted.country,
      extracted.state,
    ),
  };

  const fails = Object.values(components).filter((s) => s === "fail").length;
  const status: FieldStatus =
    fails === 0 ? "pass" : fails <= 1 ? "review" : "fail";

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
        : `${fails} producer component${fails === 1 ? "" : "s"} did not match.`,
  };
}
