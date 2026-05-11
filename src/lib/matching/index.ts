// Field comparators. Implementations land in Phase 5 of TODO.md.

export type FieldStatus = "pass" | "fail" | "review";

export interface FieldComparison {
  field: string;
  status: FieldStatus;
  expected: unknown;
  actual: unknown;
  confidence: number;
  reason?: string;
}

export interface ComparatorOptions {
  /** Fuzzy match threshold (0–1). */
  threshold?: number;
}
