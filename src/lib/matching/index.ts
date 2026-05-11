// Field comparators. Implementations land in Phase 5 of TODO.md.

export type FieldStatus = "pass" | "fail" | "review";

export interface FieldComparison {
  field: string;
  status: FieldStatus;
  expected: unknown;
  actual: unknown;
  confidence: number;
  reason?: string;
  // For producer / address, a per-component breakdown so the UI can show
  // "street matches, city doesn't" instead of collapsing to one FAIL.
  components?: Record<string, FieldStatus>;
}

export interface ComparatorOptions {
  /** Levenshtein-ratio threshold for fuzzy fields (default 0.92). */
  levenshteinThreshold?: number;
  /** Token-set-ratio backstop for short strings (default 0.85). */
  tokenSetThreshold?: number;
}

// TTB-style ABV tolerance in absolute percentage points, per class.
// See TEST-STRATEGY.md §7. Beer: ±0.3 pp. Wine: ±0.5 pp (<14% ABV)
// or ±1.0 pp (≥14%). Distilled spirits: ±0.15 pp.
export const ABV_TOLERANCE_PP: Record<string, number | ((abv: number) => number)> = {
  beer: 0.3,
  wine: (abv: number) => (abv < 14 ? 0.5 : 1.0),
  distilled_spirits: 0.15,
  fortified_wine: 1.0,
};
