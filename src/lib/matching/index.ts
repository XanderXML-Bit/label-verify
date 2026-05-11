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
}

export { compareBrand, normalizeBrand } from "./brand";
export { compareAbv, abvTolerancePP, type ClassCategory } from "./abv";
export { compareNetContents, toMl } from "./net-contents";
export { compareProducer } from "./producer";
export { compareCountry } from "./country";
export { compareClass } from "./class";
