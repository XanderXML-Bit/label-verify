// Field comparators. Re-exports the public surface; per-field logic lives
// in sibling files (brand.ts, abv.ts, net-contents.ts, producer.ts,
// country.ts, class.ts).

export type FieldStatus = "pass" | "fail" | "review";

export interface FieldComparison {
  field: string;
  status: FieldStatus;
  expected: unknown;
  actual: unknown;
  confidence: number;
  reason?: string;
  /**
   * For producer / address, a per-component breakdown so the UI can show
   * "street matches, city doesn't" instead of collapsing to one FAIL.
   */
  components?: Record<string, FieldStatus>;
  /**
   * Wave-35 Track 1 #1 (re-scoped PASS reasoning): when a PASS verdict
   * is *non-trivial* — i.e., the comparator accepted via a tolerance,
   * a fuzzy match, an implicit-USA-from-state inference, or a
   * country-synonym canonicalisation — emit a one-sentence plain-
   * English explanation here so a reviewer auditing the verdict
   * understands WHY the field was a PASS and not a FAIL.
   *
   * Deliberately separate from `reason` (which historically carries
   * FAIL / REVIEW explanations and is asserted-absent on PASS by
   * existing tests). Only emitted by the four PASS bins listed
   * above. Trivial exact-match PASSes have `passReason === undefined`.
   *
   * Surfaced in the UI only in detailed mode.
   */
  passReason?: string;
}

export { compareBrand, normalizeBrand } from "./brand";
export { compareAbv, abvTolerancePP, type ClassCategory } from "./abv";
export { compareNetContents, toMl } from "./net-contents";
export { compareProducer } from "./producer";
export { compareCountry } from "./country";
export { compareClass } from "./class";
