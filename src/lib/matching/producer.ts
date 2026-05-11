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
    country: statusFor(declared.country ?? "", extracted.country),
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
